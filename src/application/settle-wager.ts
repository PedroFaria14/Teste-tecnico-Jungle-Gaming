import type { EventContext, IntegrationEvent } from '../domain/events';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { type ReferenceContext, type SettlementPolicy, settleWager } from '../domain/wager-settlement';
import type { Wallet } from '../domain/wallet';
import { metrics } from '../shared/observability/metrics';
import type { Repositories, WagerTransactionRepository } from './ports';

/**
 * Orquestra a liquidação de uma transação, DENTRO de uma unidade de trabalho já aberta e com a
 * wallet já travada. Três passos bem separados:
 *
 *   1. carregar o que a regra precisa ler (referência + se já foi revertida)  → portas
 *   2. decidir                                                                → domínio puro (settleWager)
 *   3. persistir transação, ledger, saldo e eventos (outbox) no mesmo commit   → portas
 *
 * Usado pela submissão (HTTP/SQS) e pelo worker de PENDING_REFERENCE.
 */
export async function settleAndPersist(params: {
  repos: Repositories;
  wallet: Wallet;
  tx: WagerTransaction;
  isNew: boolean;
  now: Date;
  policy: SettlementPolicy;
  ctx: EventContext;
}): Promise<void> {
  const { repos, wallet, tx, isNew, now, policy, ctx } = params;
  const statusBefore = tx.status;
  const versionBefore = wallet.version;

  const referenceContext = await loadReferenceContext(repos.transactions, tx);
  const entry = settleWager(wallet, tx, referenceContext, now, policy);

  // Ordem respeita as FKs: transação → ledger.
  if (isNew) await repos.transactions.insert(tx);
  else await repos.transactions.updateState(tx, now);
  if (entry) {
    await repos.ledger.insert(entry);
    await repos.wallets.saveBalance(wallet, versionBefore);
  }
  for (const event of eventsFor(tx, wallet, entry, statusBefore, ctx)) {
    await repos.outbox.insert(OutboxMessage.enqueue(event));
  }

  if (tx.isTerminal() || statusBefore !== tx.status) {
    metrics.transactionsTotal.inc({ kind: tx.kind, status: tx.status, failure_code: tx.failureCode ?? 'none' });
  }
}

async function loadReferenceContext(
  transactions: WagerTransactionRepository,
  tx: WagerTransaction,
): Promise<ReferenceContext> {
  if (!tx.hasReference()) return { alreadyReversed: false };
  const reference = await transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
  const alreadyReversed = reference && tx.isReversal() ? await transactions.hasProcessedReversal(reference.id) : false;
  return { reference, alreadyReversed };
}

/** Eventos de integração derivados do desfecho. */
function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  statusBefore: WagerTransactionStatus,
  ctx: EventContext,
): IntegrationEvent<unknown>[] {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return entry
        ? [WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx)]
        : [WagerTransactionProcessed.from(tx, ctx)];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, ctx)];
    case WagerTransactionStatus.PendingReference:
      // Só no primeiro adiamento; os reagendamentos seguintes não geram evento novo.
      return statusBefore === WagerTransactionStatus.PendingReference
        ? []
        : [WagerTransactionPendingReference.from(tx, ctx)];
    default:
      return [];
  }
}
