import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com escala fixa de 2 casas', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.01').toString()).toBe('0.01');
    expect(brl('999999999999999.99').toString()).toBe('999999999999999.99');
  });

  test('soma e subtração são exatas (sem erro de ponto flutuante)', () => {
    // Em float: 0.1 + 0.2 = 0.30000000000000004
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('20.00').subtract(brl('80.00')).toString()).toBe('-60.00');
  });

  test('não arredonda: rejeita mais de 2 casas decimais', () => {
    expect(() => brl('1.005')).toThrow(InvalidMoneyError);
    expect(() => brl('0.001')).toThrow(InvalidMoneyError);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' '],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1.'],
    ['.50'],
    ['1,00'],
    ['abc'],
    ['1000000000000000.00'], // 16 dígitos inteiros: não cabe em NUMERIC(19,2)
  ])('rejeita entrada inválida %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (number é proibido para dinheiro)', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita moeda fora do formato ISO-4217', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('é imutável: operações devolvem novas instâncias', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a.negate().toString()).toBe('-10.00');
    expect(a.toString()).toBe('10.00');
  });

  test('comparações', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80').equals(brl('80.00'))).toBe(true);
  });

  test('fromDatabase aceita valores negativos (diferença de reconciliação)', () => {
    expect(Money.fromDatabase('-5.00', 'BRL').toString()).toBe('-5.00');
    expect(Money.fromDatabase('975.00', 'BRL').toString()).toBe('975.00');
  });
});
