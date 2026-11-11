import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterEach(async () => expectAllWalletsConsistent(ctx));
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

const money = (amount: string, currency = 'BRL') => ({ amount, currency });

describe('regras de negócio (PostgreSQL real)', () => {
  test('BET debita, WIN credita, LOSS não move saldo', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = await submit(ctx, wager(wallet, { kind: 'BET', money: money('25.00') }));
    expect(bet.tx.status).toBe('PROCESSED');
    expect(bet.tx.resultBalance?.toString()).toBe('75.00');

    const win = await submit(ctx, wager(wallet, { kind: 'WIN', money: money('40.00') }));
    expect(win.tx.resultBalance?.toString()).toBe('115.00');

    const loss = await submit(ctx, wager(wallet, { kind: 'LOSS', money: money('0.00') }));
    expect(loss.tx.status).toBe('PROCESSED');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE transaction_id = $1`, [loss.tx.id])).toBe(0);

    const stored = await ctx.wallets.get(wallet.id);
    expect(stored.balance.toString()).toBe('115.00');
    expect(stored.version).toBe(3); // abertura=1, +BET, +WIN (LOSS não incrementa)
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS e não gera ledger', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const { tx } = await submit(ctx, wager(wallet, { money: money('10.01') }));
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE transaction_id = $1`, [tx.id])).toBe(0);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'`)).toBe(1);
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('replay devolve o resultado ORIGINAL (inclusive o saldo daquele momento)', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const command = wager(wallet, { money: money('30.00') });
    const first = await submit(ctx, command);
    await submit(ctx, wager(wallet, { money: money('10.00') })); // saldo muda depois
    const replay = await submit(ctx, command);
    expect(replay.replay).toBe(true);
    expect(replay.tx.id).toBe(first.tx.id);
    expect(replay.tx.resultBalance?.toString()).toBe('70.00');
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('60.00');
  });

  test('mesma idempotency key com payload diferente é conflito, não replay', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const command = wager(wallet, { money: money('30.00') });
    await submit(ctx, command);
    await expect(submit(ctx, { ...command, money: money('31.00') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('70.00');
  });

  test('mesmo externalTransactionId com outra key é conflito', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const command = wager(wallet);
    await submit(ctx, command);
    await expect(submit(ctx, { ...command, idempotencyKey: 'other-key' })).rejects.toMatchObject({
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
    });
  });

  test('conflito de moeda é REJECTED com CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const { tx } = await submit(ctx, wager(wallet, { money: money('10.00', 'USD') }));
    expect(tx.status).toBe('REJECTED');
    expect(tx.failureCode).toBe('CURRENCY_MISMATCH');
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('player diferente do dono da wallet é rejeitado', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const { tx } = await submit(ctx, wager({ id: wallet.id, playerId: crypto.randomUUID() }));
    expect(tx.failureCode).toBe('PLAYER_WALLET_MISMATCH');
  });

  test('wallet inexistente → WALLET_NOT_FOUND', async () => {
    await expect(submit(ctx, wager({ id: crypto.randomUUID(), playerId: crypto.randomUUID() }))).rejects.toMatchObject({
      code: 'WALLET_NOT_FOUND',
    });
  });

  test('REFUND credita a BET uma única vez', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('40.00') });
    await submit(ctx, bet);
    const refund = await submit(
      ctx,
      wager(wallet, { kind: 'REFUND', money: money('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund.tx.status).toBe('PROCESSED');
    expect(refund.tx.resultBalance?.toString()).toBe('100.00');

    const second = await submit(
      ctx,
      wager(wallet, { kind: 'REFUND', money: money('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(second.tx.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const rollback = await submit(
      ctx,
      wager(wallet, { kind: 'ROLLBACK', money: money('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback.tx.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('100.00');
  });

  test('REFUND com valor diferente, de outra rodada ou de um WIN é rejeitado', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('40.00') });
    await submit(ctx, bet);
    const win = wager(wallet, { kind: 'WIN', money: money('5.00') });
    await submit(ctx, win);
    const ref = bet.externalTransactionId;

    const partial = await submit(ctx, wager(wallet, { kind: 'REFUND', money: money('20.00'), referenceExternalTransactionId: ref }));
    expect(partial.tx.failureCode).toBe('AMOUNT_MISMATCH');
    const otherRound = await submit(
      ctx,
      wager(wallet, { kind: 'REFUND', money: money('40.00'), roundId: 'round-2', referenceExternalTransactionId: ref }),
    );
    expect(otherRound.tx.failureCode).toBe('REFERENCE_MISMATCH');
    const refundOfWin = await submit(
      ctx,
      wager(wallet, { kind: 'REFUND', money: money('5.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(refundOfWin.tx.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('ROLLBACK de WIN debita; sem saldo é REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const win = wager(wallet, { kind: 'WIN', money: money('50.00') });
    await submit(ctx, win);
    await submit(ctx, wager(wallet, { money: money('55.00') })); // gasta o ganho: saldo 5.00

    const rollback = await submit(
      ctx,
      wager(wallet, { kind: 'ROLLBACK', money: money('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollback.tx.status).toBe('REJECTED');
    expect(rollback.tx.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('5.00');
  });

  test('ROLLBACK de BET credita de volta', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('60.00') });
    await submit(ctx, bet);
    const rollback = await submit(
      ctx,
      wager(wallet, { kind: 'ROLLBACK', money: money('60.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback.tx.status).toBe('PROCESSED');
    expect(rollback.tx.referenceTransactionId).toBeDefined();
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('100.00');
  });

  test('REFUND antes da BET → PENDING_REFERENCE → processado quando a BET chega', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const bet = wager(wallet, { money: money('40.00') });
    const refundCommand = wager(wallet, {
      kind: 'REFUND',
      money: money('40.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const early = await submit(ctx, refundCommand);
    expect(early.tx.status).toBe('PENDING_REFERENCE');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference'`)).toBe(1);

    await submit(ctx, bet);
    await Bun.sleep(80);
    await ctx.pending.processDue();

    const final = await ctx.wallets.get(wallet.id);
    expect(final.balance.toString()).toBe('100.00');
    const replay = await submit(ctx, refundCommand);
    expect(replay.tx.status).toBe('PROCESSED');
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('referência que nunca chega → REJECTED REFERENCE_NOT_FOUND após o limite, com evento', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const { tx } = await submit(
      ctx,
      wager(wallet, { kind: 'REFUND', money: money('10.00'), referenceExternalTransactionId: 'never-arrives' }),
    );
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(250);
      await ctx.pending.processDue();
    }
    const final = await ctx.wallets.get(wallet.id);
    const row = await ctx.dataSource.query(`SELECT status, failure_code FROM wager_transactions WHERE id = $1`, [tx.id]);
    expect(row[0]).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND aggregate_id = $1`, [tx.id])).toBe(1);
    expect(final.balance.toString()).toBe('100.00');
  });

  test('ledger paginado com cursor estável', async () => {
    const wallet = await openWallet(ctx, '100.00');
    for (let i = 0; i < 7; i++) await submit(ctx, wager(wallet, { money: money('1.00') }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await ctx.wallets.ledger(wallet.id, cursor, 3);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.length).toBe(8);
    expect(new Set(seen).size).toBe(8);
    await expect(ctx.wallets.ledger(wallet.id, 'not-a-cursor', 3)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
