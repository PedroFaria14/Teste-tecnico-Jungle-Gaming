import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, e esses métodos sempre
 * devolvem o lançamento de ledger correspondente — então é impossível alterar o saldo
 * sem gerar o lançamento (invariante "toda alteração de saldo tem ledger").
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma wallet. O crédito de abertura (quando > 0) é registrado por uma
   * transação interna OPENING — veja `openingLedgerEntry`.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance must not be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lançamento CREDIT do saldo inicial (0 → initialBalance). */
  openingLedgerEntry(transactionId: string): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!this.canAfford(movement.money)) {
      throw new InsufficientFundsError(
        `wallet ${this.id} has ${this._balance} ${this.currency}, cannot debit ${movement.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  move(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(movement) : this.credit(movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
