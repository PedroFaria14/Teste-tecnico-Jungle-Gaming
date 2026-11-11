function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`env ${name} must be an integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig() {
  return {
    instanceId: str('INSTANCE_ID', process.env.HOSTNAME ?? `instance-${process.pid}`),
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL', 'postgres://wagering:wagering@localhost:5433/wagering'),
    dbPoolSize: int('DB_POOL_SIZE', 20),
    /** Tempo máximo esperando o lock de uma wallet antes de virar erro transitório. */
    lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 5_000),

    aws: {
      endpoint: str('AWS_ENDPOINT_URL', 'http://localhost:4566'),
      region: str('AWS_REGION', 'us-east-1'),
      accessKeyId: str('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    queues: {
      wager: str('WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlq: str('WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      events: str('EVENTS_QUEUE_NAME', 'wallet-events'),
    },

    consumer: {
      enabled: bool('CONSUMER_ENABLED', true),
      name: str('CONSUMER_NAME', 'wager-transactions-consumer'),
      waitTimeSeconds: int('CONSUMER_WAIT_SECONDS', 5),
      visibilityTimeoutSeconds: int('CONSUMER_VISIBILITY_SECONDS', 30),
      /** Recebimentos antes de mandar para a DLQ (erros transitórios). */
      maxReceives: int('CONSUMER_MAX_RECEIVES', 5),
      retryBaseSeconds: int('CONSUMER_RETRY_BASE_SECONDS', 2),
    },
    outbox: {
      enabled: bool('OUTBOX_ENABLED', true),
      pollIntervalMs: int('OUTBOX_POLL_MS', 500),
      batchSize: int('OUTBOX_BATCH_SIZE', 200),
      /** Tempo que uma instância "segura" as mensagens que pegou. Se morrer, outra assume depois. */
      leaseMs: int('OUTBOX_LEASE_MS', 30_000),
    },
    pendingReference: {
      enabled: bool('PENDING_REFERENCE_WORKER_ENABLED', true),
      pollIntervalMs: int('PENDING_REFERENCE_POLL_MS', 1_000),
      baseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 2_000),
      maxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 5 * 60_000),
      /** 10 tentativas com base 2s e teto 5min ≈ 18 minutos de espera total. */
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
