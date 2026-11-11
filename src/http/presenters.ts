import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

/** Resposta de submissão — o mesmo formato no primeiro processamento e no replay. */
export function presentSubmission(tx: WagerTransaction, replay: boolean) {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON() ?? null,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    idempotentReplay: replay,
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balanceAfter: tx.resultBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
