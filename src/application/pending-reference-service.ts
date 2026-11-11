import { FailureCode } from '../domain/failure-codes';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { SettlementPolicy } from '../domain/wager-settlement';
import { logger, runWithLogContext } from '../shared/observability/logger';
import { metrics } from '../shared/observability/metrics';
import { type Repositories, TransientInfrastructureError, type UnitOfWork } from './ports';
import { settleAndPersist } from './settle-wager';

/**
 * Reprocessa transações PENDING_REFERENCE (REFUND/ROLLBACK/WIN que chegaram antes da referência).
 *
 * Seguro com várias instâncias: cada item é reprocessado numa transação que trava a wallet e a
 * própria transação, e re-checa status + next_attempt_at. Se outra instância já tratou, pula.
 */
export class PendingReferenceService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly policy: SettlementPolicy,
  ) {}

  /** Uma rodada do worker. Devolve quantas transações foram efetivamente reavaliadas. */
  async processDue(now = new Date(), limit = 50): Promise<number> {
    const ids = await this.uow.read((repos) => repos.transactions.findDuePendingReferenceIds(now, limit));
    let handled = 0;
    for (const id of ids) {
      if (await this.reprocess(id)) handled += 1;
    }
    return handled;
  }

  async reprocess(transactionId: string): Promise<boolean> {
    return runWithLogContext({ transactionId }, async () => {
      try {
        return await this.uow.transaction((repos) => this.reprocessInTransaction(repos, transactionId));
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          logger.warn('pending reference reprocess failed (transient), will retry later', { error });
          return false;
        }
        // Erro permanente inesperado: encerra como FAILED (auditável) em vez de ficar em loop.
        logger.error('pending reference reprocess failed permanently', { error });
        await this.markFailed(transactionId);
        return false;
      }
    });
  }

  private async reprocessInTransaction(repos: Repositories, id: string): Promise<boolean> {
    const now = new Date();
    const snapshot = await repos.transactions.findById(id);
    if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) return false;

    // Mesma ordem de locks da submissão (wallet → transação) para evitar deadlock.
    const wallet = await repos.wallets.lockForUpdate(snapshot.walletId);
    const tx = await repos.transactions.lockForUpdate(id);
    if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return false;
    if (tx.nextAttemptAt && tx.nextAttemptAt > now) return false; // outra instância já reagendou

    metrics.retriesTotal.inc({ where: 'pending_reference' });
    await settleAndPersist({
      repos,
      wallet,
      tx,
      isNew: false,
      now,
      policy: this.policy,
      ctx: { correlationId: tx.correlationId, causationId: tx.id, at: now },
    });
    logger.info('pending reference re-evaluated', {
      walletId: tx.walletId,
      providerId: tx.providerId,
      status: tx.status,
      failureCode: tx.failureCode,
      attempts: tx.referenceAttempts,
    });
    return true;
  }

  private async markFailed(id: string): Promise<void> {
    await this.uow
      .transaction(async (repos) => {
        const tx = await repos.transactions.lockForUpdate(id);
        if (!tx || tx.isTerminal()) return;
        const now = new Date();
        tx.fail(FailureCode.ProcessingFailed, now);
        await repos.transactions.updateState(tx, now);
        metrics.transactionsTotal.inc({ kind: tx.kind, status: tx.status, failure_code: FailureCode.ProcessingFailed });
      })
      .catch((error) => logger.error('could not mark transaction as FAILED', { error }));
  }
}
