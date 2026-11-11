import { InvalidLedgerEntryError } from './errors';
import { newId } from './ids';
import { Money } from './money';

export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
}

/**
 * Lançamento do ledger. Imutável por construção: todos os campos são readonly
 * e não existe nenhum método que altere estado. No banco, um trigger impede UPDATE/DELETE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      newId(),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger entry balances must not be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `ledger entry is not balanced: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito assinado no saldo: +money para CREDIT, -money para DEBIT. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
