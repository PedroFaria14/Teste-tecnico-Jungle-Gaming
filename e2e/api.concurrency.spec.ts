import { expect, test } from '@playwright/test';
import { createWallet, instance, money, reconcile, submit, URLS, wager } from './helpers';

/** Concorrência entre as 3 réplicas reais (seção 8 do desafio). */

test('CENÁRIO OBRIGATÓRIO: saldo 100, duas apostas de 80 em instâncias diferentes', async ({ request }) => {
  const wallet = await createWallet(request, '100.00');
  const results = await Promise.all([
    submit(request, wager(wallet, { money: money('80.00') }), { base: instance(1) }),
    submit(request, wager(wallet, { money: money('80.00') }), { base: instance(2) }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
  expect(results.find((r) => r.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');

  const ledger = await (await request.get(`${instance(0)}/wallets/${wallet.id}/ledger`)).json();
  expect(ledger.items.filter((e: { direction: string }) => e.direction === 'DEBIT')).toHaveLength(1);
  const rec = await reconcile(request, wallet.id);
  expect(rec.storedBalance).toEqual(money('20.00'));
});

test('a mesma aposta 50x espalhada nas 3 réplicas → exatamente 1 débito', async ({ request }) => {
  const wallet = await createWallet(request, '100.00');
  const body = wager(wallet, { money: money('10.00') });
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(request, body, { base: instance(i) })));
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status === 200)).toHaveLength(49);
  expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
  expect((await reconcile(request, wallet.id)).storedBalance).toEqual(money('90.00'));
});

test('hot wallet: 40 apostas concorrentes nunca deixam saldo negativo', async ({ request }) => {
  const wallet = await createWallet(request, '100.00');
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => submit(request, wager(wallet, { money: money('7.00') }), { base: instance(i) })),
  );
  const accepted = results.filter((r) => r.status === 201).length;
  expect(accepted).toBe(14); // floor(100 / 7)
  expect(results.filter((r) => r.status === 422)).toHaveLength(26);
  expect((await reconcile(request, wallet.id)).storedBalance).toEqual(money('2.00'));
});

test(`wallets distintas em paralelo nas ${URLS.length} réplicas`, async ({ request }) => {
  const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(request, '30.00')));
  await Promise.all(
    wallets.flatMap((w, wi) =>
      Array.from({ length: 3 }, (_, i) => submit(request, wager(w, { money: money('10.00') }), { base: instance(wi + i) })),
    ),
  );
  for (const w of wallets) {
    expect((await reconcile(request, w.id)).storedBalance).toEqual(money('0.00'));
  }
});

test('5 ROLLBACKs concorrentes da mesma BET → só um aplicado', async ({ request }) => {
  const wallet = await createWallet(request, '100.00');
  const bet = wager(wallet, { money: money('40.00') });
  await submit(request, bet);
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      submit(
        request,
        wager(wallet, { kind: 'ROLLBACK', money: money('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
        { base: instance(i) },
      ),
    ),
  );
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(4);
  expect((await reconcile(request, wallet.id)).storedBalance).toEqual(money('100.00'));
});
