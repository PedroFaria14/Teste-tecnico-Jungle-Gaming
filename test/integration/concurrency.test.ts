import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { TransientInfrastructureError } from '../../src/application/ports';
import { PgUnitOfWork } from '../../src/infrastructure/database/unit-of-work';
import {
  count,
  expectAllWalletsConsistent,
  createTestContext,
  expectLedgerConsistent,
  openWallet,
  resetDatabase,
  submit,
  type TestContext,
  wager,
} from '../helpers/context';

/**
 * Paralelismo REAL: cada chamada usa uma conexão própria do pool (até 40) e uma transação SQL
 * própria. O que serializa as operações da mesma wallet é o lock do PostgreSQL, não o teste.
 */
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterEach(async () => expectAllWalletsConsistent(ctx));
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

const money = (amount: string) => ({ amount, currency: 'BRL' });

describe('concorrência', () => {
  test('CENÁRIO OBRIGATÓRIO: saldo 100, duas apostas de 80 simultâneas', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const results = await Promise.all([
      submit(ctx, wager(wallet, { money: money('80.00') })),
      submit(ctx, wager(wallet, { money: money('80.00') })),
    ]);
    const statuses = results.map((r) => r.tx.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.tx.status === 'REJECTED')!.tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('20.00');
    expect(
      await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id]),
    ).toBe(1);

    // "nenhum retry duplica o débito": reenviar as duas apostas não muda nada.
    const retries = await Promise.all(
      results.map((r) =>
        submit(ctx, wager(wallet, { externalTransactionId: r.tx.externalTransactionId, money: money('80.00') })),
      ),
    );
    expect(retries.every((r) => r.replay)).toBe(true);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('20.00');
  });

  test('a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const command = wager(wallet, { money: money('10.00') });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(ctx, command)));

    expect(new Set(results.map((r) => r.tx.id)).size).toBe(1);
    expect(results.filter((r) => !r.replay).length).toBe(1);
    expect(results.every((r) => r.tx.resultBalance?.toString() === '90.00')).toBe(true);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE idempotency_key = $1`, [command.idempotencyKey])).toBe(1);
    expect(
      await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id]),
    ).toBe(1);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('90.00');
  });

  test('hot wallet: 60 operações misturadas disputando o mesmo saldo', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const commands = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0
        ? wager(wallet, { kind: 'WIN', money: money('5.00') })
        : wager(wallet, { kind: 'BET', money: money('7.50') }),
    );
    const results = await Promise.all(commands.map((c) => submit(ctx, c)));

    const processedBets = results.filter((r) => r.tx.kind === 'BET' && r.tx.status === 'PROCESSED').length;
    const wins = results.filter((r) => r.tx.kind === 'WIN').length;
    // saldo = 100 + 5*wins - 7.50*apostasAceitas, e nunca negativo
    let expected = Money.from(money('100.00'));
    for (let i = 0; i < wins; i++) expected = expected.add(Money.from(money('5.00')));
    for (let i = 0; i < processedBets; i++) expected = expected.subtract(Money.from(money('7.50')));
    const balance = await expectLedgerConsistent(ctx, wallet.id);
    expect(balance).toBe(expected.toString());
    expect(expected.isNegative()).toBe(false);
    const stored = await ctx.wallets.get(wallet.id);
    expect(stored.version).toBe(1 + wins + processedBets);
  });

  test('wallets distintas processadas em paralelo, sem interferência', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(ctx, '50.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(ctx, wager(w, { money: money('10.00') })))),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect(await expectLedgerConsistent(ctx, w.id)).toBe('0.00');
    }
    expect(elapsed).toBeLessThan(15_000);
  });

  test('dois ROLLBACKs concorrentes da mesma BET → só um é aplicado', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('30.00') });
    await submit(ctx, bet);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        submit(ctx, wager(wallet, { kind: 'ROLLBACK', money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    expect(results.filter((r) => r.tx.status === 'PROCESSED').length).toBe(1);
    expect(results.filter((r) => r.tx.failureCode === 'REFERENCE_ALREADY_REVERSED').length).toBe(4);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('100.00');
  });

  test('vários workers de PENDING_REFERENCE ao mesmo tempo não aplicam duas vezes', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('20.00') });
    const refund = wager(wallet, { kind: 'REFUND', money: money('20.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(ctx, refund)).tx.status).toBe('PENDING_REFERENCE');
    await submit(ctx, bet);
    await Bun.sleep(80);
    await Promise.all([ctx.pending.processDue(), ctx.pending.processDue(), ctx.pending.processDue()]);
    expect(
      await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`, [wallet.id]),
    ).toBe(2); // abertura + refund
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('100.00');
  });
});

describe('falha transitória (lock preso por outro processo)', () => {
  test('lock_timeout esgotado → TransientInfrastructureError (503); reenviar a MESMA requisição depois funciona', async () => {
    const wallet = await openWallet(ctx, '100.00');
    // Outra "instância" segura o lock da wallet numa transação aberta.
    const holder = ctx.dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [wallet.id]);

    const impatient = new SubmitWagerTransaction(new PgUnitOfWork(ctx.dataSource, { lockTimeoutMs: 100 }), ctx.policy);
    const command = wager(wallet, { money: money('30.00') });
    try {
      await expect(impatient.execute(command, { correlationId: 'test' })).rejects.toBeInstanceOf(TransientInfrastructureError);
      // Nada foi gravado pela tentativa que falhou.
      expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE idempotency_key = $1`, [command.idempotencyKey])).toBe(0);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }

    // O provedor reenvia a mesma requisição: agora passa, e só uma vez.
    const retry = await submit(ctx, command);
    expect(retry.tx.status).toBe('PROCESSED');
    expect((await submit(ctx, command)).replay).toBe(true);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('70.00');
  });
});
