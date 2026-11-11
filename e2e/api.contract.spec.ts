import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createWallet, expectMoneyAsStrings, instance, money, reconcile, submit, URLS, wager } from './helpers';

/** Contrato HTTP (seção 9 do desafio) verificado de fora, contra as réplicas do Docker Compose. */

test.describe('health e observabilidade', () => {
  for (const url of URLS) {
    test(`instância ${url}: live e ready sem autenticação`, async ({ request }) => {
      expect((await request.get(`${url}/health/live`)).status()).toBe(200);
      const ready = await request.get(`${url}/health/ready`);
      expect(ready.status()).toBe(200);
      expect(await ready.json()).toMatchObject({ checks: { postgres: 'up', sqs: 'up' } });
    });
  }

  test('/metrics expõe as métricas mínimas exigidas', async ({ request }) => {
    const text = await (await request.get(`${instance(0)}/metrics`)).text();
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'outbox_lag_seconds',
      'wager_processing_latency_seconds',
    ]) {
      expect(text, `métrica ${name}`).toContain(`# TYPE ${name}`);
    }
  });

  test('correlation id é propagado (header de entrada → resposta e corpo de erro)', async ({ request }) => {
    const res = await request.get(`${instance(0)}/wallets/${randomUUID()}`, {
      headers: { 'X-Correlation-Id': 'e2e-corr-123' },
    });
    expect(res.status()).toBe(404);
    expect(res.headers()['x-correlation-id']).toBe('e2e-corr-123');
    expect(await res.json()).toMatchObject({ error: { code: 'WALLET_NOT_FOUND' }, correlationId: 'e2e-corr-123' });
  });
});

test.describe('wallets', () => {
  test('criação devolve o contrato do enunciado com version 1', async ({ request }) => {
    const { body, playerId } = await createWallet(request, '1000.00');
    expect(body).toEqual({ id: expect.any(String), playerId, balance: money('1000.00'), version: 1 });
  });

  test('wallet duplicada (player + moeda) → 409 com formato de erro padrão', async ({ request }) => {
    const { playerId } = await createWallet(request);
    const res = await request.post(`${instance(1)}/wallets`, { data: { playerId, initialBalance: money('1.00') } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'WALLET_ALREADY_EXISTS', message: expect.any(String) } });
  });

  test.describe('dinheiro inválido é recusado com 400', () => {
    for (const amount of ['10', '1.005', '1e3', 'NaN', 'Infinity', '-5.00', '']) {
      test(`amount=${JSON.stringify(amount)}`, async ({ request }) => {
        const res = await request.post(`${instance(0)}/wallets`, {
          data: { playerId: randomUUID(), initialBalance: { amount: amount === '10' ? 10 : amount, currency: 'BRL' } },
        });
        // "10" (number) e as strings inválidas: todos 400. "10" como number é a prova de que number é proibido.
        expect(res.status()).toBe(400);
      });
    }
  });

  test('ledger paginado com cursor estável e opaco; dinheiro sempre string', async ({ request }) => {
    const wallet = await createWallet(request);
    for (let i = 0; i < 5; i++) await submit(request, wager(wallet, { money: money('1.00') }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `${instance(1)}/wallets/${wallet.id}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page: { items: { id: string }[]; nextCursor: string | null } = await (await request.get(url)).json();
      expectMoneyAsStrings(page);
      seen.push(...page.items.map((e: { id: string }) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6); // abertura + 5 apostas
    expect(new Set(seen).size).toBe(6);
    const bad = await request.get(`${instance(0)}/wallets/${wallet.id}/ledger?cursor=xyz`);
    expect(bad.status()).toBe(400);
  });

  test('reconciliação devolve o contrato completo', async ({ request }) => {
    const wallet = await createWallet(request, '50.00');
    const body = await reconcile(request, wallet.id);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: money('50.00'),
      calculatedBalance: money('50.00'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 1,
    });
  });
});

test.describe('submissão de transações — mapeamento de status', () => {
  test('201 processada → 200 replay idêntico → 409 payload divergente', async ({ request }) => {
    const wallet = await createWallet(request);
    const body = wager(wallet, { money: money('25.00') });

    const first = await submit(request, body, { base: instance(0) });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: money('75.00'),
      idempotentReplay: false,
    });

    const replay = await submit(request, body, { base: instance(1) });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await submit(request, { ...body, money: money('26.00') }, { base: instance(2) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  test('chaves JSON em outra ordem = mesmo payload (hash canônico) → replay', async ({ request }) => {
    const wallet = await createWallet(request);
    const body = wager(wallet);
    await submit(request, body);
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const res = await submit(request, reordered, { key: `${body.providerId}:${body.externalTransactionId}` });
    expect(res.status).toBe(200);
    expect(res.body.idempotentReplay).toBe(true);
  });

  test('422 rejeição de negócio com failureCode; replay da rejeição também é 422', async ({ request }) => {
    const wallet = await createWallet(request, '10.00');
    const body = wager(wallet, { money: money('10.01') });
    const res = await submit(request, body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: money('10.00') });
    const again = await submit(request, body);
    expect(again.status).toBe(422);
    expect(again.body.idempotentReplay).toBe(true);
  });

  test('400: sem Idempotency-Key, kind OPENING, REFUND sem referência, UUID inválido, campo extra', async ({ request }) => {
    const wallet = await createWallet(request);
    expect((await submit(request, wager(wallet), { key: null })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await submit(request, wager(wallet, { kind: 'OPENING' }))).status).toBe(400);
    expect((await submit(request, wager(wallet, { kind: 'REFUND' }))).status).toBe(400);
    expect((await submit(request, wager(wallet, { walletId: 'not-a-uuid' }))).status).toBe(400);
    expect((await submit(request, wager(wallet, { hacker: true }))).status).toBe(400);
    expect((await request.get(`${instance(0)}/wagering/transactions/123`)).status()).toBe(400);
  });

  test('404 wallet inexistente', async ({ request }) => {
    const res = await submit(request, wager({ id: randomUUID(), playerId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('202 REFUND antes da BET → vira PROCESSED quando a BET chega (outra instância)', async ({ request }) => {
    const wallet = await createWallet(request);
    const bet = wager(wallet, { money: money('30.00') });
    const refund = wager(wallet, {
      kind: 'REFUND',
      money: money('30.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await submit(request, refund, { base: instance(0) });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    expect((await submit(request, bet, { base: instance(1) })).status).toBe(201);

    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${instance(2)}/providers/${refund.providerId}/wagering/transactions/${refund.externalTransactionId}`,
              )
            ).json()
          ).status,
        { timeout: 30_000 },
      )
      .toBe('PROCESSED');
    const final = await reconcile(request, wallet.id);
    expect(final.storedBalance).toEqual(money('100.00'));
  });

  test('consultas por id interno e por id do provedor devolvem a mesma transação', async ({ request }) => {
    const wallet = await createWallet(request);
    const body = wager(wallet);
    const { body: created } = await submit(request, body);
    const byId = await (await request.get(`${instance(1)}/wagering/transactions/${created.transactionId}`)).json();
    const byExt = await (
      await request.get(`${instance(2)}/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`)
    ).json();
    expect(byId).toEqual(byExt);
    expect(byId).toMatchObject({ id: created.transactionId, kind: 'BET', status: 'PROCESSED', money: money('10.00') });
    expectMoneyAsStrings(byId);
  });
});

test('JSON malformado → 400 INVALID_PAYLOAD (mesmo formato de erro)', async ({ request }) => {
  const res = await request.post(`${instance(0)}/wallets`, {
    headers: { 'content-type': 'application/json' },
    data: '{"playerId": ',
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: 'INVALID_PAYLOAD' } });
});
