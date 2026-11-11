import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect } from '@playwright/test';

export const URLS = (process.env.E2E_URLS ?? 'http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3002').split(',');
export const instance = (i: number) => URLS[i % URLS.length]!;

export const money = (amount: string, currency = 'BRL') => ({ amount, currency });

export async function createWallet(request: APIRequestContext, amount = '100.00', base = instance(0)) {
  const playerId = randomUUID();
  const res = await request.post(`${base}/wallets`, { data: { playerId, initialBalance: money(amount) } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.id as string, playerId, body };
}

export function wager(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `e2e-${randomUUID()}`;
  return {
    providerId: 'provider-e2e',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: money('10.00'),
    ...overrides,
  };
}

export async function submit(
  request: APIRequestContext,
  body: Record<string, unknown>,
  opts: { base?: string; key?: string | null } = {},
) {
  const key = opts.key === undefined ? `${body.providerId}:${body.externalTransactionId}` : opts.key;
  const res = await request.post(`${opts.base ?? instance(0)}/wagering/transactions`, {
    data: body,
    headers: key === null ? {} : { 'Idempotency-Key': key },
  });
  return { status: res.status(), body: await res.json(), headers: res.headers() };
}

/** Garante, recursivamente, que todo valor monetário é string com 2 casas — nunca number. */
export function expectMoneyAsStrings(value: unknown, path = '$'): void {
  if (Array.isArray(value)) return value.forEach((v, i) => expectMoneyAsStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('amount' in obj && 'currency' in obj) {
      expect(typeof obj.amount, `${path}.amount deve ser string`).toBe('string');
      expect(obj.amount as string, `${path}.amount com 2 casas`).toMatch(/^-?\d+\.\d{2}$/);
    }
    for (const [k, v] of Object.entries(obj)) expectMoneyAsStrings(v, `${path}.${k}`);
  }
}

export async function reconcile(request: APIRequestContext, walletId: string, base = instance(0)) {
  const res = await request.post(`${base}/wallets/${walletId}/reconciliation`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.consistent, 'wallet.balance == saldo reconstruído pelo ledger').toBe(true);
  return body;
}
