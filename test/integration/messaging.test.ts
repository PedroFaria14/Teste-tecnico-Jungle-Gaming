import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { newId } from '../../src/domain/ids';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import {
  count,
  expectAllWalletsConsistent,
  createTestContext,
  eventually,
  expectLedgerConsistent,
  openWallet,
  purgeQueues,
  queueDepth,
  resetDatabase,
  type TestContext,
  wager,
} from '../helpers/context';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterEach(async () => expectAllWalletsConsistent(ctx));
afterAll(async () => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx);
  await purgeQueues(ctx);
});

function consumer(useCase: SubmitWagerTransaction = ctx.submit, overrides: Partial<{ maxReceives: number }> = {}) {
  return new WagerConsumer(ctx.sqs, useCase, {
    queueUrl: ctx.queues.wager,
    dlqUrl: ctx.queues.wagerDlq,
    consumerName: 'test-consumer',
    waitTimeSeconds: 1,
    maxReceives: overrides.maxReceives ?? 5,
    retryBaseSeconds: 1,
  });
}

async function sendWagerMessage(data: ReturnType<typeof wager>, messageId = newId()) {
  await ctx.sqs.send(
    new SendMessageCommand({
      QueueUrl: ctx.queues.wager,
      MessageGroupId: data.walletId,
      MessageDeduplicationId: newId(), // simula o provedor reenviando (dedup do SQS NÃO protege aqui)
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      }),
    }),
  );
  return messageId;
}

async function drainConsumer(c: WagerConsumer, rounds = 5) {
  const results = [];
  for (let i = 0; i < rounds; i++) {
    const batch = await c.pollOnce();
    results.push(...batch);
    if (batch.length === 0 && (await queueDepth(ctx, ctx.queues.wager)) === 0) break;
  }
  return results;
}

const money = (amount: string) => ({ amount, currency: 'BRL' });

describe('consumer SQS + inbox', () => {
  test('processa a mensagem pelo mesmo use case e confirma só depois do commit', async () => {
    const wallet = await openWallet(ctx, '100.00');
    await sendWagerMessage(wager(wallet, { money: money('25.00') }));
    const results = await drainConsumer(consumer());
    expect(results).toContain('acked');
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('75.00');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM inbox_messages WHERE processed_at IS NOT NULL`)).toBe(1);
    expect(await queueDepth(ctx, ctx.queues.wager)).toBe(0);
  });

  test('redelivery da mesma mensagem (mesmo messageId) não duplica efeito', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const data = wager(wallet, { money: money('25.00') });
    const messageId = await sendWagerMessage(data);
    await sendWagerMessage(data, messageId);
    await sendWagerMessage(data, messageId);
    await drainConsumer(consumer());
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('75.00');
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM inbox_messages`)).toBe(1);
    await expectLedgerConsistent(ctx, wallet.id);
  });

  test('worker morto DEPOIS do commit e ANTES do ack: mensagem volta e não duplica', async () => {
    const wallet = await openWallet(ctx, '100.00');
    await sendWagerMessage(wager(wallet, { money: money('40.00') }));

    // "Worker A": recebe, faz commit e morre sem apagar a mensagem.
    const received = await ctx.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: ctx.queues.wager,
        VisibilityTimeout: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['All'],
        AttributeNames: ['All'],
      }),
    );
    const message = received.Messages![0]!;
    await consumer().handle(message, { ack: false });
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('60.00');

    // "Worker B": a visibilidade expira, a mensagem é reentregue, o inbox detecta a duplicata.
    await Bun.sleep(1_500);
    await eventually(async () => {
      await consumer().pollOnce();
      return (await queueDepth(ctx, ctx.queues.wager)) === 0;
    });
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('60.00');
    expect(
      await count(ctx, `SELECT COUNT(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [wallet.id]),
    ).toBe(1);
  });

  test('mensagem inválida (payload permanente) vai direto para a DLQ', async () => {
    await ctx.sqs.send(
      new SendMessageCommand({ QueueUrl: ctx.queues.wager, MessageGroupId: 'g', MessageBody: '{"not":"valid"}' }),
    );
    const results = await drainConsumer(consumer());
    expect(results).toContain('dead-lettered');
    expect(await queueDepth(ctx, ctx.queues.wagerDlq)).toBe(1);
  });

  test('dinheiro inválido no payload vai para a DLQ, sem efeito no saldo', async () => {
    const wallet = await openWallet(ctx, '100.00');
    await sendWagerMessage(wager(wallet, { money: money('1e3') }));
    await drainConsumer(consumer());
    expect(await queueDepth(ctx, ctx.queues.wagerDlq)).toBe(1);
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('100.00');
  });

  test('rejeição de negócio é confirmada (ack), não vai para a DLQ', async () => {
    const wallet = await openWallet(ctx, '10.00');
    await sendWagerMessage(wager(wallet, { money: money('50.00') }));
    const results = await drainConsumer(consumer());
    expect(results).toEqual(['acked']);
    expect(await queueDepth(ctx, ctx.queues.wagerDlq)).toBe(0);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM wager_transactions WHERE failure_code = 'INSUFFICIENT_FUNDS'`)).toBe(1);
  });

  test('erro transitório: retry com backoff e DLQ ao esgotar o limite', async () => {
    const wallet = await openWallet(ctx, '100.00');
    await sendWagerMessage(wager(wallet));
    // Use case que simula o PostgreSQL fora do ar (o SQS continua real).
    const failing = {
      execute: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      },
    } as unknown as SubmitWagerTransaction;
    const c = consumer(failing, { maxReceives: 2 });
    const seen: string[] = [];
    await eventually(async () => {
      seen.push(...(await c.pollOnce()));
      return seen.includes('dead-lettered');
    }, 20_000);
    expect(seen.filter((r) => r === 'retry').length).toBe(1);
    expect(await queueDepth(ctx, ctx.queues.wagerDlq)).toBe(1);
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('100.00');
  });

  test('shutdown: stop() espera o que está em andamento e encerra o loop', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const c = consumer();
    c.start();
    await sendWagerMessage(wager(wallet, { money: money('1.00') }));
    await eventually(async () => (await ctx.wallets.get(wallet.id)).balance.toString() === '99.00');
    await c.stop();
    await sendWagerMessage(wager(wallet, { money: money('1.00') }));
    await Bun.sleep(1_500);
    expect((await ctx.wallets.get(wallet.id)).balance.toString()).toBe('99.00'); // parado de verdade
  });
});

describe('transactional outbox', () => {
  async function receiveAllEvents(expected: number) {
    const ids: string[] = [];
    await eventually(async () => {
      const r = await ctx.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: ctx.queues.events,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
        }),
      );
      for (const m of r.Messages ?? []) {
        ids.push(m.MessageAttributes!.eventId!.StringValue!);
        await ctx.sqs.send(new DeleteMessageCommand({ QueueUrl: ctx.queues.events, ReceiptHandle: m.ReceiptHandle! }));
      }
      return ids.length >= expected;
    }, 30_000);
    return ids;
  }

  function publisher(leaseMs = 30_000) {
    return new OutboxPublisher(ctx.uow, ctx.sqs, { eventsQueueUrl: ctx.queues.events, batchSize: 7, leaseMs });
  }

  test('dois publishers na mesma outbox: nada se perde e nada é publicado em dobro', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => openWallet(ctx, '10.00')));
    const total = await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages`);
    expect(total).toBe(wallets.length * 2); // abertura: WagerTransactionProcessed + WalletBalanceChanged

    const a = publisher();
    const b = publisher();
    let published = 0;
    while ((await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL`)) > 0) {
      const [x, y] = await Promise.all([a.publishOnce(), b.publishOnce()]);
      published += x + y;
    }
    expect(published).toBe(total);
    const ids = await receiveAllEvents(total);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total);
  });

  test('commit feito, processo morre antes de publicar, outra instância assume', async () => {
    await openWallet(ctx, '10.00');
    await openWallet(ctx, '20.00');

    const dying = publisher(500);
    const claimed = await dying.claim(); // pegou o lote... e "morreu" aqui
    expect(claimed.length).toBe(4);

    const survivor = publisher(500);
    expect(await survivor.publishOnce()).toBe(0); // lease ainda vale: não rouba
    await Bun.sleep(700);
    expect(await survivor.publishOnce()).toBe(4); // lease venceu: assume
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE published_at IS NULL`)).toBe(0);
    const ids = await receiveAllEvents(4);
    expect(new Set(ids).size).toBe(4);
  });

  test('evento só existe na outbox depois do commit (nunca antes)', async () => {
    const wallet = await openWallet(ctx, '100.00');
    const before = await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages`);
    await ctx.uow
      .transaction(async (repos) => {
        const now = new Date();
        await repos.outbox.insert(
          OutboxMessage.rehydrate({ id: newId(), aggregateId: wallet.id, eventType: 'X', payload: {}, occurredAt: now, attempts: 0, nextAttemptAt: now }),
        );
        // outro publisher olhando agora não enxerga (não houve commit)
        expect(await publisher().publishOnce()).toBe(before);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await count(ctx, `SELECT COUNT(*) AS n FROM outbox_messages WHERE event_type = 'X'`)).toBe(0);
  });
});
