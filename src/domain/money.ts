import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // string decimal com 2 casas, ex.: "25.00"
  currency: string; // ISO-4217
}

const SCALE = 2;
const FACTOR = 100n;
// Aceita "25", "25.5" e "25.50". Rejeita sinal, notação científica, espaços, zeros à esquerda,
// mais de 2 casas e qualquer coisa que não seja dígito. 15 dígitos inteiros cabem em NUMERIC(19,2).
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável.
 *
 * Internamente o valor é guardado em CENTAVOS como `bigint` (inteiro de precisão arbitrária).
 * Assim não existe `number`/float em nenhum ponto e soma/subtração são exatas.
 * Como a escala é fixa em 2 casas e só fazemos soma/subtração, não há arredondamento:
 * entradas com mais de 2 casas são REJEITADAS em vez de arredondadas.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada de contratos externos: nunca aceita valor negativo. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${String(amount)}": expected a non-negative decimal string with at most ${SCALE} decimal places`,
      );
    }
    const [integerPart, fractionPart = ''] = amount.split('.');
    const cents = BigInt(integerPart!) * FACTOR + BigInt(fractionPart.padEnd(SCALE, '0'));
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  /**
   * Lê um valor vindo do banco (NUMERIC devolvido como texto pelo driver `pg`).
   * Diferente de `from`, aceita sinal negativo (usado em diferenças de reconciliação).
   */
  static fromDatabase(amount: string, currency: string): Money {
    const negative = amount.startsWith('-');
    const money = Money.from({ amount: negative ? amount.slice(1) : amount, currency });
    return negative ? money.negate() : money;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Apenas o valor decimal com 2 casas, ex.: "-5.00" ou "975.00". */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
  }
}
