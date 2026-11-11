import { describe, expect, test } from 'bun:test';
import { wagerPayloadHash } from '../../src/application/payload-hash';
import { DomainValidationError, InvalidTransactionStateError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-codes';
import { InboxMessage } from '../../src/domain/inbox-message';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/domain/events';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T12:00:00Z');
const policy = { baseDelayMs: 1000, maxDelayMs: 8000 };

function make(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `ext-${Math.random()}`,
    idempotencyKey: 'key',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game',
    kind: Kind.Bet,
    money: brl('10.00'),
    correlationId: 'corr',
    at: now,
    ...overrides,
  });
}

function processed(tx: WagerTransaction): WagerTransaction {
  tx.markProcessed(undefined, now, brl('0.00'));
  return tx;
}

describe('WagerTransaction — criação', () => {
  test('nasce PENDING', () => {
    expect(make().status).toBe(Status.Pending);
  });

  test('OPENING não pode ser submetido de fora', () => {
    expect(() => make({ kind: Kind.Opening })).toThrow(DomainValidationError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => make({ kind: Kind.Refund })).toThrow(DomainValidationError);
    expect(() => make({ kind: Kind.Rollback })).toThrow(DomainValidationError);
    expect(make({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET e LOSS não aceitam referência', () => {
    expect(() => make({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(DomainValidationError);
    expect(() => make({ kind: Kind.Loss, referenceExternalTransactionId: 'x' })).toThrow(DomainValidationError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => make({ kind: Kind.Bet, money: brl('0.00') })).toThrow(DomainValidationError);
    expect(() => make({ kind: Kind.Win, money: brl('0') })).toThrow(DomainValidationError);
    expect(make({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });
});

describe('WagerTransaction — transições', () => {
  test('PENDING → PROCESSED guarda saldo observado e referência', () => {
    const tx = make();
    tx.markProcessed('ref-id', now, brl('90.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultBalance?.toString()).toBe('90.00');
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.isTerminal()).toBe(true);
  });

  test('estados terminais não transicionam (erro de programação)', () => {
    const p = processed(make());
    expect(() => p.reject(FailureCode.InsufficientFunds, now, brl('0'))).toThrow(InvalidTransactionStateError);
    expect(() => p.markPendingReference(now, policy, brl('0'))).toThrow(InvalidTransactionStateError);

    const r = make();
    r.reject(FailureCode.InsufficientFunds, now, brl('0'));
    expect(() => r.markProcessed(undefined, now, brl('0'))).toThrow(InvalidTransactionStateError);

    const f = make();
    f.fail(FailureCode.ProcessingFailed, now);
    expect(() => f.markProcessed(undefined, now, brl('0'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE reagenda com backoff exponencial limitado', () => {
    const tx = make({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      tx.markPendingReference(now, policy, brl('0'));
      delays.push(tx.nextAttemptAt!.getTime() - now.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(tx.referenceAttempts).toBe(5);
    tx.markProcessed('bet-id', now, brl('10.00'));
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test('payload diferente com a mesma key não é replay', () => {
    const tx = make({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('WagerTransaction — regras por operação', () => {
  test('direção do ledger por kind', () => {
    expect(make({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      make({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(() => make({ kind: Kind.Loss, money: brl('0') }).ledgerDirectionFor()).toThrow();
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rollback = make({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(make({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(make({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })),
    ).toBe(LedgerDirection.Debit);
  });

  test('REFUND só referencia BET', () => {
    const refund = make({ kind: Kind.Refund, referenceExternalTransactionId: 'x' });
    expect(refund.referenceViolation(processed(make({ kind: Kind.Bet })))).toBeUndefined();
    expect(refund.referenceViolation(processed(make({ kind: Kind.Win })))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('ROLLBACK referencia BET, WIN ou REFUND (nunca LOSS/ROLLBACK)', () => {
    const rollback = make({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.referenceViolation(processed(make({ kind: Kind.Win })))).toBeUndefined();
    expect(rollback.referenceViolation(processed(make({ kind: Kind.Loss, money: brl('10.00') })))).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
    expect(
      rollback.referenceViolation(processed(make({ kind: Kind.Rollback, referenceExternalTransactionId: 'y' }))),
    ).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('referência precisa ser da mesma rodada, player, wallet e moeda', () => {
    const refund = make({ kind: Kind.Refund, referenceExternalTransactionId: 'x' });
    expect(refund.referenceViolation(processed(make({ roundId: 'other' })))).toBe(FailureCode.ReferenceMismatch);
    expect(refund.referenceViolation(processed(make({ playerId: 'other' })))).toBe(FailureCode.ReferenceMismatch);
    expect(refund.referenceViolation(processed(make({ walletId: 'other' })))).toBe(FailureCode.ReferenceMismatch);
    expect(refund.referenceViolation(processed(make({ providerId: 'other' })))).toBe(FailureCode.ReferenceMismatch);
  });

  test('reversão precisa ter o mesmo valor da referência', () => {
    const refund = make({ kind: Kind.Refund, referenceExternalTransactionId: 'x', money: brl('5.00') });
    expect(refund.referenceViolation(processed(make({ money: brl('10.00') })))).toBe(FailureCode.AmountMismatch);
  });

  test('referência não processada (REJECTED) não pode ser revertida', () => {
    const bet = make();
    bet.reject(FailureCode.InsufficientFunds, now, brl('0'));
    const refund = make({ kind: Kind.Refund, referenceExternalTransactionId: 'x' });
    expect(refund.referenceViolation(bet)).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('payloadHash', () => {
  const base = {
    providerId: 'p',
    externalTransactionId: 'e',
    playerId: 'pl',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };

  test('é independente da ordem das chaves', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '10.00' },
      kind: 'BET',
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'pl',
      externalTransactionId: 'e',
      providerId: 'p',
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
  });

  test('muda quando qualquer campo de negócio muda', () => {
    expect(wagerPayloadHash({ ...base, money: { amount: '10.01', currency: 'BRL' } })).not.toBe(wagerPayloadHash(base));
    expect(wagerPayloadHash({ ...base, roundId: 'r2' })).not.toBe(wagerPayloadHash(base));
  });
});

describe('Inbox / Outbox / eventos', () => {
  test('inbox não pode ser processada duas vezes', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', at: now });
    inbox.markProcessed(now);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(now)).toThrow(InvalidTransactionStateError);
  });

  test('outbox: backoff, due e publicação', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00'), at: now });
    const entry = wallet.openingLedgerEntry('t');
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'c', at: now });
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.isDue(now)).toBe(true);
    message.scheduleRetry(now, { baseDelayMs: 1000, maxDelayMs: 60_000 });
    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 1000))).toBe(true);
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(now)).toThrow(InvalidTransactionStateError);
  });

  test('envelope do evento: ISO-8601, eventType/version no tipo, money como string', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('10.00'), at: now });
    const json = WalletBalanceChanged.from(wallet, wallet.openingLedgerEntry('t'), { correlationId: 'c', at: now }).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-11-11T12:00:00.000Z');
    expect(json.data.balanceAfter).toEqual({ amount: '10.00', currency: 'BRL' });
  });
});
