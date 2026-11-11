import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { canonicalJson, sha256Hex } from '../../application/payload-hash';
import type { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { wagerMessageSchema } from '../../application/contracts';
import { DomainConflictError, DomainValidationError, NotFoundError } from '../../domain/errors';
import { logger, runWithLogContext } from '../../shared/observability/logger';
import { metrics } from '../../shared/observability/metrics';

export interface WagerConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxReceives: number;
  retryBaseSeconds: number;
}

export type HandleResult = 'acked' | 'retry' | 'dead-lettered' | 'released';

/**
 * Consumer da fila `wager-transactions.fifo`.
 *
 * - reusa o MESMO use case do HTTP;
 * - deduplica pelo inbox persistente (consumerName, messageId) dentro da transação SQL;
 * - só apaga (ack) a mensagem DEPOIS do commit;
 * - classifica erros: negócio → ack | transitório → backoff via visibilidade | permanente → DLQ.
 */
export class WagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly useCase: SubmitWagerTransaction,
    private readonly options: WagerConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    logger.info('wager consumer started', { queue: this.options.queueUrl });
  }

  /**
   * Graceful shutdown (SIGTERM): para de buscar, termina as mensagens que já estão em
   * processamento e devolve imediatamente (visibilidade 0) as que ainda não começaram.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    await this.loop;
    logger.info('wager consumer stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        logger.error('wager consumer poll failed', { error });
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  /** Uma rodada de long polling. Exposto para testes. */
  async pollOnce(): Promise<HandleResult[]> {
    this.abort = new AbortController();
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['All'],
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) return [];

    // FIFO: mensagens do mesmo grupo (wallet) em ordem; grupos diferentes em paralelo.
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    const results = await Promise.all(
      [...groups.values()].map(async (group) => {
        const out: HandleResult[] = [];
        for (const message of group) {
          if (!this.running && this.loop) {
            await this.changeVisibility(message, 0);
            out.push('released');
            continue;
          }
          out.push(await this.handle(message));
        }
        return out;
      }),
    );
    return results.flat();
  }

  async handle(message: Message, opts: { ack?: boolean } = {}): Promise<HandleResult> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let parsed;
    try {
      parsed = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
    } catch (error) {
      logger.warn('invalid wager message', { sqsMessageId: message.MessageId, error: (error as Error).message });
      return this.deadLetter(message, 'INVALID_MESSAGE');
    }

    const correlationId =
      message.MessageAttributes?.correlationId?.StringValue ?? parsed.messageId;
    return runWithLogContext({ correlationId, messageId: parsed.messageId }, async () => {
      try {
        const { idempotencyKey, ...body } = parsed.data;
        const outcome = await this.useCase.execute(
          { ...body, idempotencyKey },
          {
            correlationId,
            inbox: {
              consumerName: this.options.consumerName,
              messageId: parsed.messageId,
              payloadHash: sha256Hex(canonicalJson(parsed)),
            },
          },
        );
        // A partir daqui o COMMIT já aconteceu — só então confirmamos a mensagem.
        if (opts.ack !== false) await this.ack(message);
        logger.info('wager message processed', {
          outcome: outcome.type === 'decided' ? outcome.transaction.status : 'DUPLICATE',
        });
        return 'acked';
      } catch (error) {
        if (error instanceof DomainValidationError) {
          // Payload inválido: reenviar não resolve — vai para a DLQ para análise.
          return this.deadLetter(message, error.code);
        }
        if (error instanceof DomainConflictError || error instanceof NotFoundError) {
          // Erro de negócio terminal: confirma e segue (fica registrado no log).
          logger.warn('wager message rejected by business rule', { code: error.code, error: error.message });
          await this.ack(message);
          return 'acked';
        }
        // Transitório (banco fora, lock, etc.) ou inesperado: tenta de novo com backoff, até o limite.
        if (receiveCount >= this.options.maxReceives) {
          return this.deadLetter(message, 'MAX_RECEIVES_EXCEEDED');
        }
        const delay = Math.min(900, this.options.retryBaseSeconds * 2 ** (receiveCount - 1));
        metrics.retriesTotal.inc({ where: 'sqs' });
        logger.warn('wager message failed, will retry', { receiveCount, delaySeconds: delay, error });
        await this.changeVisibility(message, delay).catch(() => undefined);
        return 'retry';
      }
    });
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async deadLetter(message: Message, reason: string): Promise<HandleResult> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          receiveCount: { DataType: 'String', StringValue: message.Attributes?.ApproximateReceiveCount ?? '1' },
        },
      }),
    );
    await this.ack(message);
    metrics.dlqTotal.inc({ reason });
    logger.error('wager message sent to DLQ', { reason, sqsMessageId: message.MessageId });
    return 'dead-lettered';
  }
}
