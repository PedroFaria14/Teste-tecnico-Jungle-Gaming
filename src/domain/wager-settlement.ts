import { FailureCode } from './failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from './ledger-entry';
import {
  type RetryPolicy,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import type { Wallet } from './wallet';

export interface SettlementPolicy extends RetryPolicy {
  /** Tentativas de resolver a referência antes de desistir (REFERENCE_NOT_FOUND). */
  maxAttempts: number;
}

/** O que precisa ser lido do banco ANTES de decidir. Montado pela aplicação. */
export interface ReferenceContext {
  /** A transação referenciada (por providerId + referenceExternalTransactionId), se existir. */
  reference?: WagerTransaction;
  /** A referência já foi revertida por um REFUND/ROLLBACK processado? */
  alreadyReversed: boolean;
}

/**
 * SERVIÇO DE DOMÍNIO PURO — decide o desfecho de uma transação PENDING / PENDING_REFERENCE.
 *
 * Sem I/O: recebe a wallet (já travada pela aplicação), a transação e o contexto da referência,
 * aplica as regras de negócio e muda o estado dos agregados. Devolve o lançamento de ledger
 * quando há movimento de saldo. Por ser puro, é testado sem banco (test/unit/wager-settlement.test.ts).
 *
 * Ordem das regras:
 *  1. player e moeda precisam bater com a wallet;
 *  2. referência ausente (ou ainda pendente) → PENDING_REFERENCE com backoff, ou REJECTED ao esgotar;
 *  3. referência precisa ser compatível (kind, provider, player, wallet, rodada, moeda, valor, PROCESSED);
 *  4. uma referência só é revertida uma vez;
 *  5. LOSS não move saldo;
 *  6. débito sem saldo → INSUFFICIENT_FUNDS (aposta) ou REVERSAL_INSUFFICIENT_FUNDS (reversão);
 *  7. senão, movimenta a wallet e marca PROCESSED com o saldo resultante.
 */
export function settleWager(
  wallet: Wallet,
  tx: WagerTransaction,
  context: ReferenceContext,
  now: Date,
  policy: SettlementPolicy,
): WalletLedgerEntry | undefined {
  if (tx.playerId !== wallet.playerId) {
    tx.reject(FailureCode.PlayerWalletMismatch, now, wallet.balance);
    return undefined;
  }
  if (tx.money.currency !== wallet.currency) {
    tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
    return undefined;
  }

  const { reference } = context;
  if (tx.hasReference()) {
    if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
      if (tx.referenceAttempts >= policy.maxAttempts) {
        tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
      } else {
        tx.markPendingReference(now, policy, wallet.balance);
      }
      return undefined;
    }
    const violation = tx.referenceViolation(reference);
    if (violation) {
      tx.reject(violation, now, wallet.balance);
      return undefined;
    }
    if (tx.isReversal() && context.alreadyReversed) {
      tx.reject(FailureCode.ReferenceAlreadyReversed, now, wallet.balance);
      return undefined;
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return undefined;
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canAfford(tx.money)) {
    tx.reject(
      tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds,
      now,
      wallet.balance,
    );
    return undefined;
  }

  const entry = wallet.move(direction, { transactionId: tx.id, money: tx.money, at: now });
  tx.markProcessed(reference?.id, now, wallet.balance);
  return entry;
}
