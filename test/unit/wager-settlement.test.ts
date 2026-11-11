import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-codes';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { settleWager } from '../../src/domain/wager-settlement';
import { Wallet } from '../../src/domain/wallet';

/**
 * Regras de liquidação testadas SEM banco: o serviço de domínio é puro.
 * (Os mesmos cenários rodam também contra PostgreSQL real nos testes de integração.)
 */
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T12:00:00Z');
const policy = { baseDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 3 };
const noRef = { alreadyReversed: false };

function wallet(balance = '100.00') {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(balance), at: now });
}

function tx(overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `ext-${Math.random()}`,
    idempotencyKey: 'k',
    payloadHash: 'h',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'g',
    kind: Kind.Bet,
    money: brl('10.00'),
    correlationId: 'c',
    at: now,
    ...overrides,
  });
}

function processedBet(amount = '40.00') {
  const bet = tx({ money: brl(amount) });
  bet.markProcessed(undefined, now, brl('60.00'));
  return bet;
}

describe('settleWager', () => {
  test('BET com saldo: debita, gera DEBIT e PROCESSED com saldo resultante', () => {
    const w = wallet();
    const t = tx({ money: brl('80.00') });
    const entry = settleWager(w, t, noRef, now, policy);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(t.status).toBe(Status.Processed);
    expect(t.resultBalance?.toString()).toBe('20.00');
    expect(w.balance.toString()).toBe('20.00');
  });

  test('BET sem saldo: REJECTED INSUFFICIENT_FUNDS, wallet intacta, sem lançamento', () => {
    const w = wallet('20.00');
    const t = tx({ money: brl('80.00') });
    expect(settleWager(w, t, noRef, now, policy)).toBeUndefined();
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('LOSS: PROCESSED sem movimento', () => {
    const w = wallet();
    const t = tx({ kind: Kind.Loss, money: brl('0.00') });
    expect(settleWager(w, t, noRef, now, policy)).toBeUndefined();
    expect(t.status).toBe(Status.Processed);
    expect(w.version).toBe(1);
  });

  test('player ou moeda divergentes são rejeitados antes de tudo', () => {
    const t1 = tx({ playerId: 'other' });
    settleWager(wallet(), t1, noRef, now, policy);
    expect(t1.failureCode).toBe(FailureCode.PlayerWalletMismatch);

    const t2 = tx({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
    settleWager(wallet(), t2, noRef, now, policy);
    expect(t2.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('referência ausente: PENDING_REFERENCE com backoff; ao esgotar → REFERENCE_NOT_FOUND', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-x' });
    for (let i = 0; i < policy.maxAttempts; i++) {
      settleWager(wallet(), t, noRef, now, policy);
      expect(t.status).toBe(Status.PendingReference);
    }
    settleWager(wallet(), t, noRef, now, policy);
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('REFUND de BET processada: CREDIT e aponta para a referência', () => {
    const bet = processedBet();
    const w = wallet('60.00');
    const refund = tx({ kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    const entry = settleWager(w, refund, { reference: bet, alreadyReversed: false }, now, policy);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('referência já revertida → REFERENCE_ALREADY_REVERSED', () => {
    const bet = processedBet();
    const refund = tx({ kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    settleWager(wallet(), refund, { reference: bet, alreadyReversed: true }, now, policy);
    expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const win = tx({ kind: Kind.Win, money: brl('50.00') });
    win.markProcessed(undefined, now, brl('150.00'));
    const rollback = tx({ kind: Kind.Rollback, money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId });
    settleWager(wallet('5.00'), rollback, { reference: win, alreadyReversed: false }, now, policy);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  });

  test('referência ainda em PENDING_REFERENCE faz a dependente esperar também', () => {
    const pendingWin = tx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-late' });
    pendingWin.markPendingReference(now, policy, brl('100.00'));
    const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: pendingWin.externalTransactionId });
    settleWager(wallet(), rollback, { reference: pendingWin, alreadyReversed: false }, now, policy);
    expect(rollback.status).toBe(Status.PendingReference);
  });
});
