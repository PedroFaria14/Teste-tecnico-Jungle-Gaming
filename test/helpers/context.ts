/**
 * Infra compartilhada dos testes de integração. Usa PostgreSQL e LocalStack REAIS
 * (docker compose up -d postgres localstack). Nada de mock de banco ou fila.
 */
import { GetQueueAttributesCommand, PurgeQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DataSource } from 'typeorm';
import { PendingReferenceService } from '../../src/application/pending-reference-service';
import { SubmitWagerTransaction, type SubmitWagerCommand } from '../../src/application/submit-wager-transaction';
import type { SettlementPolicy } from '../../src/domain/wager-settlement';
import { WalletService } from '../../src/application/wallet-service';
import { type AppConfig, loadConfig } from '../../src/config';
import { newId } from '../../src/domain/ids';
import type { WagerTransaction } from '../../src/domain/wager-transaction';
import { createDataSource } from '../../src/infrastructure/database/data-source';
import { PgUnitOfWork } from '../../src/infrastructure/database/unit-of-work';
import { createSqsClient, ensureQueues, type QueueUrls } from '../../src/infrastructure/messaging/sqs';

process.env.LOG_LEVEL ??= 'error';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering_test';

export interface TestContext {
  config: AppConfig;
  dataSource: DataSource;
  uow: PgUnitOfWork;
  sqs: SQSClient;
  queues: QueueUrls;
  policy: SettlementPolicy;
  submit: SubmitWagerTransaction;
  wallets: WalletService;
  pending: PendingReferenceService;
  close(): Promise<void>;
}

/** Cada arquivo de teste ganha filas próprias (sufixo aleatório) para não interferir nos outros. */
export async function createTestContext(overrides: { lockTimeoutMs?: number } = {}): Promise<TestContext> {
  const suffix = newId().slice(-8);
  process.env.WAGER_QUEUE_NAME = `wager-transactions-${suffix}.fifo`;
  process.env.WAGER_DLQ_NAME = `wager-transactions-dlq-${suffix}.fifo`;
  process.env.EVENTS_QUEUE_NAME = `wallet-events-${suffix}`;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const config = loadConfig();

  const dataSource = createDataSource(TEST_DATABASE_URL, 40);
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });

  const uow = new PgUnitOfWork(dataSource, { lockTimeoutMs: overrides.lockTimeoutMs ?? 5_000 });
  const sqs = createSqsClient(config);
  const queues = await ensureQueues(sqs, config);
  const policy: SettlementPolicy = { baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 3 };

  return {
    config,
    dataSource,
    uow,
    sqs,
    queues,
    policy,
    submit: new SubmitWagerTransaction(uow, policy),
    wallets: new WalletService(uow),
    pending: new PendingReferenceService(uow, policy),
    async close() {
      await dataSource.destroy();
      sqs.destroy();
    },
  };
}

export async function resetDatabase(ctx: TestContext): Promise<void> {
  // TRUNCATE não dispara os triggers de linha que bloqueiam DELETE no ledger.
  await ctx.dataSource.query(
    `TRUNCATE wallet_ledger_entries, outbox_messages, inbox_messages, wager_transactions, wallets RESTART IDENTITY CASCADE`,
  );
}

export async function purgeQueues(ctx: TestContext): Promise<void> {
  for (const url of [ctx.queues.wager, ctx.queues.wagerDlq, ctx.queues.events]) {
    await ctx.sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
}

export async function queueDepth(ctx: TestContext, url: string): Promise<number> {
  const result = await ctx.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export async function openWallet(ctx: TestContext, amount = '100.00', currency = 'BRL') {
  return ctx.wallets.create({ playerId: newId(), initialBalance: { amount, currency } }, 'test');
}

let seq = 0;
export function wager(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  seq += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${seq}-${newId().slice(-6)}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export async function submit(ctx: TestContext, command: SubmitWagerCommand): Promise<{ tx: WagerTransaction; replay: boolean }> {
  const outcome = await ctx.submit.execute(command, { correlationId: 'test' });
  if (outcome.type !== 'decided') throw new Error('expected decided outcome');
  return { tx: outcome.transaction, replay: outcome.replay };
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerConsistent(ctx: TestContext, walletId: string): Promise<string> {
  const result = await ctx.wallets.reconcile(walletId);
  if (!result.consistent) {
    throw new Error(
      `wallet ${walletId} inconsistent: stored=${result.storedBalance.amount} ledger=${result.calculatedBalance.amount}`,
    );
  }
  return result.storedBalance.amount;
}

export async function count(ctx: TestContext, sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await ctx.dataSource.query(sql, params)) as { n: string }[];
  return Number(rows[0]?.n ?? 0);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(stepMs);
  }
  throw new Error('condition not met in time');
}

/**
 * Invariante final de TODOS os testes de integração (rodada em afterEach):
 * para cada wallet do banco, wallet.balance == saldo reconstruído pelo ledger, e nenhum saldo negativo.
 */
export async function expectAllWalletsConsistent(ctx: TestContext): Promise<void> {
  const rows = (await ctx.dataSource.query(
    `SELECT w.id, w.balance::text AS stored,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS ledger
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      GROUP BY w.id, w.balance
     HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
         OR w.balance < 0`,
  )) as { id: string; stored: string; ledger: string }[];
  if (rows.length > 0) {
    throw new Error(`invariante violada (saldo ≠ ledger): ${JSON.stringify(rows)}`);
  }
}
