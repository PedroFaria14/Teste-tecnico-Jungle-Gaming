import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-11T12:00:00Z');

function openWallet(initial = '100.00') {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), at: now });
}

describe('Wallet', () => {
  test('abre com version 1 e moeda do saldo inicial', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('lançamento de abertura credita 0 → saldo inicial', () => {
    const entry = openWallet().openingLedgerEntry('tx-open');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('100.00');
  });

  test('debit gera lançamento DEBIT coerente e incrementa version', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ transactionId: 'tx-1', money: brl('80.00'), at: now });
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('saldo nunca fica negativo: debit sem saldo lança e não altera nada', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.debit({ transactionId: 'tx-1', money: brl('80.00'), at: now })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  test('permite debitar exatamente o saldo inteiro', () => {
    const wallet = openWallet('80.00');
    wallet.debit({ transactionId: 'tx-1', money: brl('80.00'), at: now });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('credit soma e incrementa version', () => {
    const wallet = openWallet();
    wallet.credit({ transactionId: 'tx-1', money: brl('0.01'), at: now });
    expect(wallet.balance.toString()).toBe('100.01');
    expect(wallet.version).toBe(2);
  });

  test('moeda da operação precisa ser a moeda da wallet', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit({ transactionId: 'tx', money: usd, at: now })).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit({ transactionId: 'tx', money: usd, at: now })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('saldo final == saldo reconstruído pelo ledger', () => {
    const wallet = openWallet();
    const entries = [wallet.openingLedgerEntry('open')];
    entries.push(wallet.debit({ transactionId: 'a', money: brl('30.00'), at: now }));
    entries.push(wallet.credit({ transactionId: 'b', money: brl('12.34'), at: now }));
    entries.push(wallet.debit({ transactionId: 'c', money: brl('82.34'), at: now }));
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('0.00');
  });
});

describe('WalletLedgerEntry', () => {
  test('create valida a aritmética do lançamento', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
        createdAt: now,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('não aceita lançamento de valor zero nem saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00'),
        createdAt: now,
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
        createdAt: now,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável (sem métodos de transição)', () => {
    const entry = openWallet().openingLedgerEntry('t');
    const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter(
      (n) => n !== 'constructor' && n !== 'isBalanced' && n !== 'signedAmount',
    );
    expect(mutators).toEqual([]);
  });
});
