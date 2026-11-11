import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.aws.endpoint,
    region: config.aws.region,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
  });
}

export interface QueueUrls {
  wager: string;
  wagerDlq: string;
  events: string;
}

async function createOrGet(sqs: SQSClient, name: string, attributes: Record<string, string>): Promise<string> {
  try {
    const created = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    return created.QueueUrl!;
  } catch (error) {
    // Fila já existe com atributos diferentes: usamos a existente.
    if ((error as Error).name?.includes('QueueAlreadyExists') || (error as Error).name?.includes('QueueNameExists')) {
      const existing = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      return existing.QueueUrl!;
    }
    throw error;
  }
}

/**
 * Cria as filas se não existirem (idempotente). A fila principal tem redrive para a DLQ como
 * rede de segurança — o consumer também move explicitamente quando esgota as tentativas.
 */
export async function ensureQueues(sqs: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'true' };
  const wagerDlq = await createOrGet(sqs, config.queues.wagerDlq, fifo);
  const dlqAttributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerDlq, AttributeNames: ['QueueArn'] }),
  );
  const wager = await createOrGet(sqs, config.queues.wager, {
    ...fifo,
    VisibilityTimeout: String(config.consumer.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqAttributes.Attributes!.QueueArn,
      // +1: o consumer move para a DLQ na N-ésima entrega; o redrive só pega se o processo morrer.
      maxReceiveCount: config.consumer.maxReceives + 1,
    }),
  });
  const events = await createOrGet(sqs, config.queues.events, {});
  return { wager, wagerDlq, events };
}

export async function pingSqs(sqs: SQSClient, queueUrl: string): Promise<void> {
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
}
