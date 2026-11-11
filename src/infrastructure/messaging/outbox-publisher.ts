import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { UnitOfWork } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { logger } from '../../shared/observability/logger';
import { metrics } from '../../shared/observability/metrics';

export interface OutboxPublisherOptions {
  eventsQueueUrl: string;
  batchSize: number;
  leaseMs: number;
}

/** Limite do SQS por chamada de SendMessageBatch. */
const SQS_BATCH_LIMIT = 10;
const LAG_REFRESH_MS = 1_000;

/**
 * Publica eventos da outbox. Pode rodar em N instâncias ao mesmo tempo:
 *
 * 1. claim: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) empurra next_attempt_at
 *    para frente (lease) e faz commit — duas instâncias nunca pegam a mesma linha no mesmo ciclo.
 * 2. publica no SQS (fora da transação), em lotes de 10 enviados em PARALELO.
 * 3. marca published_at do lote inteiro com um único UPDATE.
 *
 * Se o processo morrer entre 1 e 3, o lease vence e outra instância publica de novo.
 * Resultado: at-least-once. Duplicatas são seguras porque todo evento carrega `eventId` estável.
 *
 * Throughput: o loop chama `publishOnce` de novo imediatamente enquanto os lotes vierem cheios
 * (ver `hasMore` no PollingLoop), então backlog é drenado sem esperar o intervalo de polling.
 */
export class OutboxPublisher {
  private lastLagRefresh = 0;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SQSClient,
    private readonly options: OutboxPublisherOptions,
  ) {}

  get batchSize(): number {
    return this.options.batchSize;
  }

  /** Uma rodada. Devolve quantos eventos foram reservados (claimed) — lote cheio = provavelmente há mais. */
  async publishOnce(now = new Date()): Promise<number> {
    const claimed = await this.claim(now);
    if (claimed.length > 0) {
      const chunks: OutboxMessage[][] = [];
      for (let i = 0; i < claimed.length; i += SQS_BATCH_LIMIT) chunks.push(claimed.slice(i, i + SQS_BATCH_LIMIT));
      const results = await Promise.all(chunks.map((chunk) => this.sendChunk(chunk)));
      await this.record(results.flatMap((r) => r.published), results.flatMap((r) => r.failed));
    }
    await this.refreshLag(claimed.length < this.options.batchSize);
    return claimed.length;
  }

  /** Separado para que os testes consigam simular "pegou e morreu antes de publicar". */
  async claim(now = new Date()): Promise<OutboxMessage[]> {
    return this.uow.transaction((repos) => repos.outbox.claimDue(now, this.options.batchSize, this.options.leaseMs));
  }

  private async sendChunk(chunk: OutboxMessage[]) {
    try {
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.options.eventsQueueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageAttributes: {
              eventId: { DataType: 'String', StringValue: message.id },
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
      );
      const ok = new Set((result.Successful ?? []).map((s) => Number(s.Id)));
      const error = result.Failed?.map((f) => f.Message ?? f.Code).join('; ') ?? 'unknown error';
      return {
        published: chunk.filter((_, i) => ok.has(i)),
        failed: chunk.filter((_, i) => !ok.has(i)).map((message) => ({ message, error })),
      };
    } catch (error) {
      return { published: [], failed: chunk.map((message) => ({ message, error: (error as Error).message })) };
    }
  }

  private async record(published: OutboxMessage[], failed: { message: OutboxMessage; error: string }[]) {
    const now = new Date();
    await this.uow.read(async (repos) => {
      if (published.length > 0) {
        published.forEach((m) => m.markPublished(now));
        await repos.outbox.markPublishedMany(published);
        for (const m of published) metrics.outboxPublishedTotal.inc({ event_type: m.eventType });
      }
      for (const { message, error } of failed) {
        message.scheduleRetry(now);
        await repos.outbox.saveRetry(message, error);
        metrics.outboxPublishFailuresTotal.inc({ event_type: message.eventType });
      }
    });
    if (failed.length > 0) logger.warn('outbox publish failed for some events', { failed: failed.length, error: failed[0]!.error });
  }

  /** Atualiza o gauge de lag no máximo 1x/s (ou sempre ao terminar de drenar). */
  private async refreshLag(force: boolean): Promise<void> {
    if (!force && Date.now() - this.lastLagRefresh < LAG_REFRESH_MS) return;
    this.lastLagRefresh = Date.now();
    metrics.outboxLagSeconds.set(await this.uow.read((repos) => repos.outbox.lagSeconds(new Date())));
  }
}
