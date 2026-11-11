import {
  ConcurrencyConflictError,
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type Repositories,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports';
import { DomainConflictError, DomainValidationError, InvalidTransactionStateError } from '../../domain/errors';
import type { FailureCode } from '../../domain/failure-codes';
import { InboxMessage } from '../../domain/inbox-message';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { isUniqueViolation } from './pg-errors';
import type { Sql } from './unit-of-work';

/**
 * ADAPTADORES PostgreSQL das portas de repositório (ver application/ports.ts).
 *
 * Mapeamento manual domínio ⇄ SQL. Money vira duas colunas: `numeric(19,2)` (o driver `pg` devolve
 * string — nunca float) + `char(3)`. Cada instância está ligada a uma conexão/transação (`Sql`).
 */

// ---- Wallet ----------------------------------------------------------------------------------

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.fromDatabase(row.balance, row.currency),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.selectOne(`SELECT * FROM wallets WHERE id = $1`, id);
  }

  /**
   * Lock pessimista da LINHA da wallet (não é lock global): só operações da mesma
   * wallet esperam umas pelas outras; wallets diferentes rodam em paralelo.
   */
  async lockForUpdate(id: string): Promise<Wallet | undefined> {
    return this.selectOne(`SELECT * FROM wallets WHERE id = $1 FOR UPDATE`, id);
  }

  async lockForShare(id: string): Promise<Wallet | undefined> {
    return this.selectOne(`SELECT * FROM wallets WHERE id = $1 FOR SHARE`, id);
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.sql.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error, 'uq_wallets_player_currency')) {
        throw new DomainConflictError(
          'WALLET_ALREADY_EXISTS',
          `player ${wallet.playerId} already has a ${wallet.currency} wallet`,
        );
      }
      throw error;
    }
  }

  /**
   * Grava o novo saldo condicionado à versão lida (defesa em profundidade além do FOR UPDATE).
   * Se outra escrita tivesse passado no meio, 0 linhas seriam afetadas e abortamos.
   */
  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { rowCount } = await this.sql.query(
      `UPDATE wallets SET balance = $2, version = $3, updated_at = $4
        WHERE id = $1 AND version = $5`,
      [wallet.id, wallet.balance.toString(), wallet.version, wallet.updatedAt, expectedVersion],
    );
    if (rowCount !== 1) throw new ConcurrencyConflictError(`wallet ${wallet.id} was modified concurrently`);
  }

  private async selectOne(sql: string, id: string): Promise<Wallet | undefined> {
    const { rows } = await this.sql.query<WalletRow>(sql, [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }
}

// ---- WagerTransaction ------------------------------------------------------------------------

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  result_balance: string | null;
  reference_attempts: number;
  next_attempt_at: Date | null;
  correlation_id: string;
  created_at: Date;
  processed_at: Date | null;
}

function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.fromDatabase(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    processedAt: row.processed_at ?? undefined,
    resultBalance:
      row.result_balance === null ? undefined : Money.fromDatabase(row.result_balance, row.currency),
    referenceAttempts: row.reference_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
  });
}

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly sql: Sql) {}

  findById(id: string) {
    return this.selectOne(`SELECT * FROM wager_transactions WHERE id = $1`, [id]);
  }

  lockForUpdate(id: string) {
    return this.selectOne(`SELECT * FROM wager_transactions WHERE id = $1 FOR UPDATE`, [id]);
  }

  findByIdempotencyKey(key: string) {
    return this.selectOne(`SELECT * FROM wager_transactions WHERE idempotency_key = $1`, [key]);
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.selectOne(
      `SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = $1 AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.sql.query<{ id: string }>(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= $1
        ORDER BY next_attempt_at
        LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    if (tx.status === WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError('a PENDING transaction must be decided before being persisted');
    }
    await this.sql.query(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, result_balance, reference_attempts,
         next_attempt_at, correlation_id, created_at, processed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.resultBalance?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextAttemptAt ?? null,
        tx.correlationId,
        tx.createdAt,
        tx.processedAt ?? null,
        tx.processedAt ?? tx.createdAt,
      ],
    );
  }

  /** Atualiza o estado mutável (só funciona se a linha ainda não for terminal — trigger no banco). */
  async updateState(tx: WagerTransaction, at: Date): Promise<void> {
    await this.sql.query(
      `UPDATE wager_transactions
          SET status = $2, reference_transaction_id = $3, failure_code = $4, result_balance = $5,
              reference_attempts = $6, next_attempt_at = $7, processed_at = $8, updated_at = $9
        WHERE id = $1`,
      [
        tx.id,
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.resultBalance?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextAttemptAt ?? null,
        tx.processedAt ?? null,
        at,
      ],
    );
  }

  private async selectOne(sql: string, params: unknown[]): Promise<WagerTransaction | undefined> {
    const { rows } = await this.sql.query<WagerTransactionRow>(sql, params);
    return rows[0] ? toWagerTransaction(rows[0]) : undefined;
  }
}

// ---- Ledger ----------------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

function toLedgerEntry(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: Money.fromDatabase(row.amount, row.currency),
    balanceBefore: Money.fromDatabase(row.balance_before, row.currency),
    balanceAfter: Money.fromDatabase(row.balance_after, row.currency),
    createdAt: row.created_at,
  });
}

/** Cursor opaco = base64url de {"s": "<seq>"}. Detalhe de persistência: a aplicação só repassa. */
function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    // cai no erro abaixo
  }
  throw new DomainValidationError('INVALID_CURSOR', 'cursor is invalid');
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly sql: Sql) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  /** Paginação por keyset (seq): estável mesmo com novos lançamentos entrando. */
  async page(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterSeq = cursor ? decodeCursor(cursor) : null;
    const { rows } = await this.sql.query<LedgerRow>(
      `SELECT * FROM wallet_ledger_entries
        WHERE wallet_id = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq ASC
        LIMIT $3`,
      [walletId, afterSeq, limit + 1],
    );
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      entries: pageRows.map(toLedgerEntry),
      nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null,
    };
  }

  /** Soma assinada feita em NUMERIC dentro do banco (exata). */
  async summarize(walletId: string, currency: string): Promise<{ total: Money; count: number }> {
    const { rows } = await this.sql.query<{ total: string; count: string }>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS total,
              COUNT(*)::text AS count
         FROM wallet_ledger_entries WHERE wallet_id = $1`,
      [walletId],
    );
    return { total: Money.fromDatabase(rows[0]!.total, currency), count: Number(rows[0]!.count) };
  }
}

// ---- Inbox -----------------------------------------------------------------------------------

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly sql: Sql) {}

  /**
   * Tenta registrar a mensagem. Se outra instância já registrou (commit feito), devolve false.
   * Se a outra ainda estiver no meio da transação, o INSERT espera o commit/rollback dela
   * (comportamento do índice único) — então não há janela para processar duas vezes.
   */
  async tryRecord(message: InboxMessage): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rowCount === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const { rows } = await this.sql.query<{
      consumer_name: string;
      message_id: string;
      payload_hash: string;
      received_at: Date;
      processed_at: Date | null;
    }>(`SELECT * FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2`, [consumerName, messageId]);
    const row = rows[0];
    if (!row) return undefined;
    return InboxMessage.rehydrate({
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? undefined,
    });
  }
}

// ---- Outbox ----------------------------------------------------------------------------------

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

function toOutbox(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at ?? undefined,
  });
}

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: Sql) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.sql.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? message.occurredAt,
      ],
    );
  }

  /**
   * "Pega" um lote de mensagens vencidas com FOR UPDATE SKIP LOCKED e empurra o next_attempt_at
   * para frente (lease). Assim, vários publishers não pegam a mesma mensagem ao mesmo tempo;
   * se o publisher morrer depois de pegar, o lease vence e outra instância assume.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const { rows } = await this.sql.query<OutboxRow>(
      `UPDATE outbox_messages o
          SET next_attempt_at = $1::timestamptz + ($3::int * interval '1 millisecond')
        WHERE o.id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [now, limit, leaseMs],
    );
    return rows.map(toOutbox);
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.sql.query(`UPDATE outbox_messages SET published_at = $2 WHERE id = $1 AND published_at IS NULL`, [
      message.id,
      message.publishedAt,
    ]);
  }

  async markPublishedMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.sql.query(
      `UPDATE outbox_messages SET published_at = $2 WHERE id = ANY($1::uuid[]) AND published_at IS NULL`,
      [messages.map((m) => m.id), messages[0]!.publishedAt],
    );
  }

  async saveRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.sql.query(
      `UPDATE outbox_messages SET attempts = $2, next_attempt_at = $3, last_error = $4
        WHERE id = $1 AND published_at IS NULL`,
      [message.id, message.attempts, message.nextAttemptAt, error.slice(0, 1000)],
    );
  }

  async lagSeconds(now: Date): Promise<number> {
    const { rows } = await this.sql.query<{ lag: string | null }>(
      `SELECT EXTRACT(EPOCH FROM ($1::timestamptz - MIN(occurred_at)))::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    const lag = rows[0]?.lag;
    return lag ? Math.max(0, Number(lag)) : 0;
  }
}

export function createRepositories(sql: Sql): Repositories {
  return {
    wallets: new PgWalletRepository(sql),
    transactions: new PgWagerTransactionRepository(sql),
    ledger: new PgLedgerRepository(sql),
    inbox: new PgInboxRepository(sql),
    outbox: new PgOutboxRepository(sql),
  };
}
