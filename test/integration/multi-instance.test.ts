import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import { newId } from '../../src/domain/ids';
import {
  count,
  expectAllWalletsConsistent,
  createTestContext,
  eventually,
  expectLedgerConsistent,
  openWallet,
  queueDepth,
  resetDatabase,
  TEST_DATABASE_URL,
  type TestContext,
  wager,
} from '../helpers/context';

/**
 * ≥ 3 PROCESSOS de verdade (bun src/main.ts), cada um com HTTP + consumer SQS + outbox publisher
 * + worker de referências, todos apontando para o mesmo PostgreSQL e as mesmas filas.
 */
let ctx: TestContext;
const PORTS = [3101, 3102, 3103];
const instances = new Map<number, Subprocess>();

function spawnInstance(port: number): Subprocess {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      INSTANCE_ID: `test-${port}`,
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'error',
      CONSUMER_WAIT_SECONDS: '1',
      OUTBOX_POLL_MS: '200',
      PENDING_REFERENCE_POLL_MS: '200',
      PENDING_REFERENCE_BASE_DELAY_MS: '100',
      PENDING_REFERENCE_MAX_DELAY_MS: '1000',
      PENDING_REFERENCE_MAX_ATTEMPTS: '120',
      DB_POOL_SIZE: '10',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  instances.set(port, proc);
  return proc;
}

async function waitReady(port: number) {
  await eventually(async () => {
    try {
      const r = await fetch(`http://localhost:${port}/health/ready`);
      return r.status === 200;
    } catch {
      return false;
    }
  }, 60_000, 250);
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

function submitHttp(port: number, command: ReturnType<typeof wager>) {
  const { idempotencyKey, ...body } = command;
  return post(port, '/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
}

beforeAll(async () => {
  process.env.CONSUMER_VISIBILITY_SECONDS = '10'; // instância morta devolve as mensagens mais rápido
  ctx = await createTestContext();
  await resetDatabase(ctx);
  PORTS.forEach(spawnInstance);
  await Promise.all(PORTS.map(waitReady));
}, 90_000);

afterEach(async () => expectAllWalletsConsistent(ctx));
afterAll(async () => {
  for (const proc of instances.values()) proc.kill();
  await Promise.all([...instances.values()].map((p) => p.exited));
  await ctx.close();
});

const money = (amount: string) => ({ amount, currency: 'BRL' });
const pick = (i: number) => PORTS[i % PORTS.length]!;

describe('3 instâncias simultâneas', () => {
  test('HTTP: duas apostas de 80 em instâncias diferentes, saldo 100', async () => {
    const created = await post(PORTS[0]!, '/wallets', { playerId: newId(), initialBalance: money('100.00') });
    expect(created.status).toBe(201);
    const wallet = { id: created.body.id as string, playerId: created.body.playerId as string };

    const [a, b] = await Promise.all([
      submitHttp(PORTS[1]!, wager(wallet, { money: money('80.00') })),
      submitHttp(PORTS[2]!, wager(wallet, { money: money('80.00') })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const rejected = a.status === 422 ? a : b;
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('20.00');
  });

  test('HTTP: a mesma aposta 50x espalhada nas 3 instâncias → 1 débito', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const command = wager(wallet, { money: money('10.00') });
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submitHttp(pick(i), command)));
    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 200).length).toBe(49);
    expect(responses.every((r) => r.body.idempotentReplay === (r.status === 200))).toBe(true);
    expect(await expectLedgerConsistent(ctx, wallet.id)).toBe('90.00');
  });

  test('HTTP: mapeamento de status distingue as situações', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const ok = wager(wallet, { money: money('1.00') });
    expect((await submitHttp(PORTS[0]!, ok)).status).toBe(201);
    expect((await submitHttp(PORTS[1]!, ok)).status).toBe(200); // replay
    expect((await submitHttp(PORTS[2]!, { ...ok, money: money('2.00') })).status).toBe(409); // conflito
    expect((await submitHttp(PORTS[0]!, wager(wallet, { money: money('99.00') }))).status).toBe(422); // negócio
    expect((await submitHttp(PORTS[0]!, wager(wallet, { money: money('1.001') }))).status).toBe(400); // inválido
    const pending = await submitHttp(
      PORTS[0]!,
      wager(wallet, { kind: 'REFUND', money: money('1.00'), referenceExternalTransactionId: 'later' }),
    );
    expect(pending.status).toBe(202);
    const { idempotencyKey: _, ...noKey } = wager(wallet);
    expect((await post(PORTS[0]!, '/wagering/transactions', noKey)).status).toBe(400);
  });

  test('SQS: 3 consumers, duplicatas, referência fora de ordem e uma instância morta e reiniciada', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(ctx, '200.00')));
    const send = (data: ReturnType<typeof wager>, messageId = newId()) =>
      ctx.sqs.send(
        new SendMessageCommand({
          QueueUrl: ctx.queues.wager,
          MessageGroupId: data.walletId,
          MessageDeduplicationId: newId(),
          MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
        }),
      );

    const bets: ReturnType<typeof wager>[] = [];
    for (const w of wallets) {
      // REFUND chega ANTES da BET referenciada
      const bet = wager(w, { money: money('15.00') });
      await send(wager(w, { kind: 'REFUND', money: money('15.00'), referenceExternalTransactionId: bet.externalTransactionId }));
      for (let i = 0; i < 8; i++) {
        const b = wager(w, { money: money('12.50') });
        bets.push(b);
        const messageId = newId();
        await send(b, messageId);
        if (i % 3 === 0) await send(b, messageId); // redelivery
      }
      await send(bet);
    }

    // Mata uma instância no meio do processamento (SIGKILL = sem graceful shutdown) e sobe de novo.
    await Bun.sleep(300);
    const victim = instances.get(PORTS[0]!)!;
    victim.kill('SIGKILL');
    await victim.exited;
    spawnInstance(PORTS[0]!);
    await waitReady(PORTS[0]!);

    // Consistência eventual: fila vazia, nenhuma referência pendente, outbox publicada.
    await eventually(async () => (await queueDepth(ctx, ctx.queues.wager)) === 0, 90_000, 500);
    await eventually(
      async () => (await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND wallet_id = ANY($1::uuid[])`, [wallets.map((w) => w.id)])) === 0,
      60_000,
      300,
    );
    await eventually(
      async () => (await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL`)) === 0,
      60_000,
      300,
    );

    for (const w of wallets) {
      // 200 - 8*12.50 - 15 + 15 = 100.00
      expect(await expectLedgerConsistent(ctx, w.id)).toBe('100.00');
    }
    expect(await queueDepth(ctx, ctx.queues.wagerDlq)).toBe(0);
    for (const b of bets) {
      expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE idempotency_key = $1`, [b.idempotencyKey])).toBe(1);
    }
  }, 180_000);
});
