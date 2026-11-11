import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { settleAndPersist } from '../../src/application/settle-wager';
import { newId } from '../../src/domain/ids';
import { Money } from '../../src/domain/money';
import { InboxMessage } from '../../src/domain/inbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { count, createTestContext, expectAllWalletsConsistent, expectLedgerConsistent, openWallet, resetDatabase, type TestContext } from '../helpers/context';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterEach(async () => expectAllWalletsConsistent(ctx));
afterAll(async () => ctx.close());
beforeEach(async () => resetDatabase(ctx));

describe('migrations', () => {
  test('são reversíveis: down e up de novo', async () => {
    await ctx.dataSource.undoLastMigration({ transaction: 'each' });
    const tables = await ctx.dataSource.query(`SELECT to_regclass('public.wallets') AS t`);
    expect(tables[0].t).toBeNull();
    await ctx.dataSource.runMigrations({ transaction: 'each' });
    const again = await ctx.dataSource.query(`SELECT to_regclass('public.wallets') AS t`);
    expect(again[0].t).toBe('wallets');
  });
});

describe('constraints do schema (garantias no banco, não só no código)', () => {
  test('saldo negativo é recusado pelo CHECK', async () => {
    const wallet = await openWallet(ctx, '10.00');
    await expect(ctx.dataSource.query(`UPDATE wallets SET balance = -0.01 WHERE id = $1`, [wallet.id])).rejects.toThrow();
  });

  test('uma wallet por player + moeda', async () => {
    const wallet = await openWallet(ctx, '10.00');
    await expect(
      ctx.wallets.create({ playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, 't'),
    ).rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    // mesma pessoa, outra moeda: permitido (modelo multi-moeda)
    const usd = await ctx.wallets.create(
      { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'USD' } },
      't',
    );
    expect(usd.currency).toBe('USD');
  });

  test('ledger é append-only: UPDATE e DELETE são bloqueados por trigger', async () => {
    const wallet = await openWallet(ctx, '10.00');
    await expect(ctx.dataSource.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.dataSource.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
  });

  test('lançamento com aritmética errada é recusado', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const [{ id: txId }] = await ctx.dataSource.query(`SELECT id FROM wager_transactions WHERE wallet_id = $1`, [wallet.id]);
    await expect(
      ctx.dataSource.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES ($1, $2, $3, 'CREDIT', 5, 'BRL', 10, 16, now())`,
        [newId(), wallet.id, txId],
      ),
    ).rejects.toThrow();
  });

  test('transação terminal não pode ser alterada', async () => {
    const wallet = await openWallet(ctx, '10.00');
    await expect(ctx.dataSource.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE wallet_id = $1`, [wallet.id])).rejects.toThrow(
      /terminal/,
    );
  });

  test('idempotency key e (provider, externalId) são únicos', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const insert = (key: string, ext: string) =>
      ctx.dataSource.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, correlation_id, created_at, processed_at, updated_at)
         VALUES ($1, 'p', $2, $3, 'h', $4, $5, 'r', 'g', 'LOSS', 0, 'BRL', 'PROCESSED', 'c', now(), now(), now())`,
        [newId(), ext, key, wallet.id, wallet.playerId],
      );
    await insert('k1', 'e1');
    await expect(insert('k1', 'e2')).rejects.toThrow();
    await expect(insert('k2', 'e1')).rejects.toThrow();
  });
});

describe('atomicidade wallet + transação + ledger + inbox + outbox', () => {
  test('se algo falha depois de tudo gravado, NADA fica persistido', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const before = await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages`);

    const attempt = ctx.uow.transaction(async (repos) => {
      const locked = (await repos.wallets.lockForUpdate(wallet.id))!;
      const inbox = InboxMessage.receive({ messageId: 'm-1', consumerName: 'test', payloadHash: 'h', at: new Date() });
      inbox.markProcessed(new Date());
      await repos.inbox.tryRecord(inbox);
      const tx = WagerTransaction.create({
        providerId: 'p',
        externalTransactionId: 'e-atomic',
        idempotencyKey: 'p:e-atomic',
        payloadHash: 'h',
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'r',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        correlationId: 'c',
        at: new Date(),
      });
      await settleAndPersist({ repos, wallet: locked, tx, isNew: true, now: new Date(), policy: ctx.policy, ctx: { correlationId: 'c', at: new Date() } });
      throw new Error('simulated crash before commit');
    });
    await expect(attempt).rejects.toThrow('simulated crash');
    await attempt.catch(() => undefined);

    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('100.00');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE external_transaction_id = 'e-atomic'`)).toBe(0);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id])).toBe(1);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM inbox_messages`)).toBe(0);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages`)).toBe(before);
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('criação de wallet grava OPENING + CREDIT + evento juntos', async () => {
    const wallet = await openWallet(ctx, '1000.00');
    expect(wallet.version).toBe(1);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING'`, [wallet.id])).toBe(1);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`, [wallet.id])).toBe(1);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE aggregate_id = $1`, [wallet.id])).toBe(1);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE event_type = 'WagerTransactionProcessed' AND payload->'data'->>'kind' = 'OPENING' AND payload->'data'->>'walletId' = $1`, [wallet.id])).toBe(1);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('1000.00');
  });

  test('wallet com saldo inicial zero não gera lançamento', async () => {
    const wallet = await openWallet(ctx, '0.00');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id])).toBe(0);
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('reconciliação detecta divergência sem corrigir', async () => {
    const wallet = await openWallet(ctx, '50.00');
    // Simula corrupção (alguém mexeu direto no banco).
    await ctx.dataSource.query(`UPDATE wallets SET balance = 55.00 WHERE id = $1`, [wallet.id]);
    const result = await ctx.wallets.reconcile(wallet.id);
    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: '5.00', currency: 'BRL' });
    expect(result.checkedEntries).toBe(1);
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('55.00'); // não corrigiu sozinho
    await ctx.dataSource.query(`UPDATE wallets SET balance = 50.00 WHERE id = $1`, [wallet.id]); // desfaz a corrupção simulada
  });
});
