import { DomainConflictError, NotFoundError } from '../domain/errors';
import { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { enrichLogContext, logger } from '../shared/observability/logger';
import { metrics } from '../shared/observability/metrics';
import type { SubmitWagerBody } from './contracts';
import { wagerPayloadHash } from './payload-hash';
import type { SettlementPolicy } from '../domain/wager-settlement';
import type { Repositories, UnitOfWork } from './ports';
import { settleAndPersist } from './settle-wager';

export class IdempotencyConflictError extends DomainConflictError {
  constructor(key: string) {
    super('IDEMPOTENCY_KEY_CONFLICT', `idempotency key "${key}" was already used with a different payload`);
  }
}

export interface SubmitWagerCommand extends SubmitWagerBody {
  idempotencyKey: string;
}

/** Presente quando a entrada veio da fila: o registro de inbox entra na mesma transação SQL. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export type SubmitOutcome =
  | { type: 'decided'; transaction: WagerTransaction; replay: boolean }
  | { type: 'duplicate-message' };

/**
 * Use case único de submissão — reutilizado pelo controller HTTP e pelo consumer SQS.
 *
 * Garantias:
 * 1. Idempotência persistente: UNIQUE(idempotency_key) no banco + comparação de payloadHash.
 * 2. Concorrência: lock pessimista da linha da wallet; operações da mesma wallet são serializadas
 *    pelo PostgreSQL, wallets diferentes rodam em paralelo.
 * 3. Atomicidade: transação, ledger, saldo, inbox e outbox no mesmo COMMIT.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: SettlementPolicy,
  ) {}

  async execute(
    command: SubmitWagerCommand,
    meta: { correlationId: string; inbox?: InboxContext },
  ): Promise<SubmitOutcome> {
    const started = performance.now();
    // Valida o dinheiro antes de qualquer I/O (lança DomainValidationError → 400 / DLQ).
    const money = Money.from(command.money);
    const payloadHash = wagerPayloadHash({ ...command, money: money.toJSON() });
    enrichLogContext({ walletId: command.walletId, providerId: command.providerId });

    try {
      // Atalho barato para replays HTTP: não precisa travar a wallet para responder um repetido.
      if (!meta.inbox) {
        const replay = await this.uow.read((repos) => this.findReplay(repos, command.idempotencyKey, payloadHash));
        if (replay) return replay;
      }

      return await this.uow.transaction((repos) => this.submitInTransaction(repos, command, money, payloadHash, meta));
    } finally {
      metrics.processingLatencySeconds.observe((performance.now() - started) / 1000, {
        source: meta.inbox ? 'sqs' : 'http',
      });
    }
  }

  private async submitInTransaction(
    repos: Repositories,
    command: SubmitWagerCommand,
    money: Money,
    payloadHash: string,
    meta: { correlationId: string; inbox?: InboxContext },
  ): Promise<SubmitOutcome> {
    const now = new Date();

    const wallet = await repos.wallets.lockForUpdate(command.walletId);
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${command.walletId} not found`);

    if (meta.inbox) {
      const inbox = InboxMessage.receive({ ...meta.inbox, at: now });
      inbox.markProcessed(now); // só vale se o COMMIT acontecer
      const recorded = await repos.inbox.tryRecord(inbox);
      if (!recorded) {
        metrics.duplicatesTotal.inc({ source: 'inbox' });
        const existing = await repos.inbox.find(meta.inbox.consumerName, meta.inbox.messageId);
        if (existing && existing.payloadHash !== meta.inbox.payloadHash) {
          // Mesmo messageId com conteúdo diferente: anomalia do produtor. Não aplicamos de novo, mas alertamos.
          metrics.inboxPayloadMismatchTotal.inc();
          logger.error('inbox messageId reused with a different payload; ignored');
        } else {
          logger.info('duplicate message ignored (inbox)');
        }
        return { type: 'duplicate-message' };
      }
    }

    // Revalida com a wallet travada: outra instância pode ter gravado a mesma key agora há pouco.
    const replay = await this.findReplay(repos, command.idempotencyKey, payloadHash);
    if (replay) return replay;

    const sameExternal = await repos.transactions.findByExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (sameExternal) {
      metrics.idempotencyConflictsTotal.inc();
      throw new DomainConflictError(
        'EXTERNAL_TRANSACTION_CONFLICT',
        `external transaction ${command.providerId}:${command.externalTransactionId} already exists under another idempotency key`,
      );
    }

    const tx = WagerTransaction.create({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: meta.correlationId,
      at: now,
    });
    enrichLogContext({ transactionId: tx.id });

    await settleAndPersist({
      repos,
      wallet,
      tx,
      isNew: true,
      now,
      policy: this.policy,
      ctx: { correlationId: meta.correlationId, causationId: meta.inbox?.messageId, at: now },
    });

    logger.info('wager transaction decided', {
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
    });
    return { type: 'decided', transaction: tx, replay: false };
  }

  private async findReplay(repos: Repositories, idempotencyKey: string, payloadHash: string): Promise<SubmitOutcome | undefined> {
    const existing = await repos.transactions.findByIdempotencyKey(idempotencyKey);
    if (!existing) return undefined;
    if (!existing.matchesPayload(payloadHash)) {
      metrics.idempotencyConflictsTotal.inc();
      throw new IdempotencyConflictError(idempotencyKey);
    }
    metrics.duplicatesTotal.inc({ source: 'idempotency_key' });
    enrichLogContext({ transactionId: existing.id });
    logger.info('idempotent replay', { status: existing.status });
    return { type: 'decided', transaction: existing, replay: true };
  }
}
