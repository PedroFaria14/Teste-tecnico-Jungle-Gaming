/**
 * Teste de carga — `bun run test:load`
 *
 * Pré-requisito: stack no ar com as 3 réplicas (`docker compose up -d --build --wait`).
 * Alvos: LOAD_URLS (padrão http://127.0.0.1:3000,3001,3002) — round-robin entre as réplicas.
 *
 * Cenários (closed-loop: N workers concorrentes, cada um envia a próxima requisição assim que a anterior volta):
 *   1. distributed  — muitas wallets, mix BET/WIN/LOSS + ~10% de reenvios idempotentes;
 *   2. hot-wallet   — todas as requisições na MESMA wallet (pior caso de contenção de lock);
 *   3. replay-storm — a mesma requisição reenviada (custo da deduplicação persistente).
 *
 * Coleta: throughput, p50/p95/p99/max, status HTTP, erros, deltas de métricas do /metrics de todas as
 * réplicas (lock conflicts, retries, duplicatas), outbox lag máximo (amostrado a cada 500 ms) e, no fim,
 * reconciliação de TODAS as wallets usadas (wallet.balance == ledger).
 *
 * Saída: tabela no console + load-test/results.json (consumido pelo LOAD_TEST.md).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const URLS = (process.env.LOAD_URLS ?? 'http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3002').split(',');
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 20);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);

let rr = 0;
const nextUrl = () => URLS[rr++ % URLS.length]!;

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  ms: number;
  status: number; // 0 = erro de rede
}

// ---- HTTP -------------------------------------------------------------------------------------

async function post(path: string, body: unknown, headers: Record<string, string> = {}, base = nextUrl()) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = randomUUID();
  const { status, json } = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  if (status !== 201) throw new Error(`wallet creation failed: ${status} ${JSON.stringify(json)}`);
  return { id: json.id as string, playerId };
}

function wagerBody(w: Wallet, kind: string, amount: string, externalTransactionId = `load-${randomUUID()}`) {
  return {
    providerId: 'load-provider',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: `round-${externalTransactionId.slice(-6)}`,
    gameId: 'load-game',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function submit(body: ReturnType<typeof wagerBody>): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(`${nextUrl()}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status };
  } catch {
    return { ms: performance.now() - started, status: 0 };
  }
}

// ---- métricas Prometheus das réplicas -----------------------------------------------------------

async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const url of URLS) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [series, value] = line.split(' ');
      const name = series!.replace(/\{.*$/, '');
      if (name.endsWith('_bucket')) continue;
      if (name === 'outbox_lag_seconds') {
        totals.set(name, Math.max(totals.get(name) ?? 0, Number(value)));
      } else {
        totals.set(series!, (totals.get(series!) ?? 0) + Number(value));
      }
    }
  }
  return totals;
}

function sumWhere(m: Map<string, number>, prefix: string, filter = ''): number {
  let total = 0;
  for (const [k, v] of m) if (k.startsWith(prefix) && k.includes(filter)) total += v;
  return total;
}

async function outboxPending(): Promise<number> {
  // Lag atual (segundos) visto por qualquer réplica — 0 = outbox vazia.
  const m = await scrape();
  return m.get('outbox_lag_seconds') ?? 0;
}

// ---- motor de carga (closed loop) --------------------------------------------------------------

async function run(name: string, concurrency: number, nextRequest: () => ReturnType<typeof wagerBody>) {
  const before = await scrape();
  const samples: Sample[] = [];
  let maxLag = 0;
  const deadline = performance.now() + DURATION_S * 1000;

  const lagSampler = setInterval(async () => {
    try {
      maxLag = Math.max(maxLag, (await scrape()).get('outbox_lag_seconds') ?? 0);
    } catch {
      /* ignora amostra */
    }
  }, 500);

  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) samples.push(await submit(nextRequest()));
    }),
  );
  const elapsedS = (performance.now() - started) / 1000;
  clearInterval(lagSampler);

  // Espera a outbox drenar e mede quanto demorou.
  const drainStart = performance.now();
  while ((await outboxPending()) > 0 && performance.now() - drainStart < 60_000) await Bun.sleep(250);
  const drainS = (performance.now() - drainStart) / 1000;

  const after = await scrape();
  const delta = (prefix: string, filter = '') => sumWhere(after, prefix, filter) - sumWhere(before, prefix, filter);

  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? 0;
  const byStatus: Record<string, number> = {};
  for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;

  return {
    scenario: name,
    concurrency,
    durationS: Number(elapsedS.toFixed(1)),
    requests: samples.length,
    throughputRps: Number((samples.length / elapsedS).toFixed(1)),
    latencyMs: {
      p50: Number(pct(50).toFixed(1)),
      p95: Number(pct(95).toFixed(1)),
      p99: Number(pct(99).toFixed(1)),
      max: Number((lat.at(-1) ?? 0).toFixed(1)),
    },
    statuses: byStatus,
    errorRatePct: Number(((errors / Math.max(1, samples.length)) * 100).toFixed(3)),
    lockConflicts: delta('wager_lock_conflicts_total'),
    unitOfWorkRetries: delta('wager_retries_total', 'unit_of_work'),
    duplicatesDetected: delta('wager_duplicates_total'),
    outboxMaxLagS: Number(maxLag.toFixed(2)),
    outboxDrainAfterRunS: Number(drainS.toFixed(2)),
  };
}

// ---- cenários ----------------------------------------------------------------------------------

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

async function main() {
  console.log(`Alvos: ${URLS.join(', ')} | duração ${DURATION_S}s/cenário | concorrência ${CONCURRENCY}`);
  for (const url of URLS) {
    const r = await fetch(`${url}/health/ready`);
    if (r.status !== 200) throw new Error(`${url} não está pronta (${r.status}). Suba: docker compose up -d --build --wait`);
  }

  console.log(`Criando ${WALLETS} wallets...`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('100000.00')))));
  }
  const hot = await createWallet('100000.00');
  const replayTarget = await createWallet('100000.00');

  const results = [];

  // 1) distribuído: 60% BET, 25% WIN, 5% LOSS, 10% reenvio idempotente de algo já enviado
  const sent: ReturnType<typeof wagerBody>[] = [];
  console.log('Cenário 1/3: distributed...');
  results.push(
    await run('distributed', CONCURRENCY, () => {
      const r = Math.random();
      if (r < 0.1 && sent.length > 0) return pick(sent);
      const w = pick(wallets);
      const body =
        r < 0.7 ? wagerBody(w, 'BET', '1.00') : r < 0.95 ? wagerBody(w, 'WIN', '1.50') : wagerBody(w, 'LOSS', '0.00');
      if (sent.length < 5_000) sent.push(body);
      return body;
    }),
  );

  // 2) hot wallet: tudo na mesma wallet — serializado pelo lock da linha
  console.log('Cenário 2/3: hot-wallet...');
  results.push(await run('hot-wallet', CONCURRENCY, () => wagerBody(hot, Math.random() < 0.7 ? 'BET' : 'WIN', '1.00')));

  // 3) replay storm: 1 requisição original + todas as outras são replays dela
  console.log('Cenário 3/3: replay-storm...');
  const original = wagerBody(replayTarget, 'BET', '5.00');
  results.push(await run('replay-storm', CONCURRENCY, () => original));

  // Consistência final de todas as wallets tocadas
  console.log('Reconciliando todas as wallets...');
  let consistent = 0;
  const inconsistent: string[] = [];
  for (const w of [...wallets, hot, replayTarget]) {
    const { json } = await post(`/wallets/${w.id}/reconciliation`, {});
    if (json.consistent === true) consistent++;
    else inconsistent.push(w.id);
  }
  const hotBalance = (await (await fetch(`${URLS[0]}/wallets/${hot.id}`)).json()) as { balance: { amount: string }; version: number };
  const replayLedger = (await (await fetch(`${URLS[0]}/wallets/${replayTarget.id}/ledger`)).json()) as { items: unknown[] };

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: `${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length} threads`,
      memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      runtime: `Bun ${Bun.version}`,
      targets: URLS,
      topology: '3 réplicas NestJS (Docker Compose) + PostgreSQL 16 + LocalStack 3.8.1 na mesma máquina; gerador de carga também na mesma máquina',
    },
    parameters: { durationSPerScenario: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS },
    results,
    finalConsistency: {
      walletsChecked: wallets.length + 2,
      consistent,
      inconsistent,
      hotWallet: { balance: hotBalance.balance.amount, version: hotBalance.version },
      replayStormLedgerEntries: replayLedger.items.length, // esperado 2: abertura + 1 débito
    },
  };

  mkdirSync('load-test', { recursive: true });
  writeFileSync('load-test/results.json', JSON.stringify(report, null, 2));

  console.table(
    results.map((r) => ({
      scenario: r.scenario,
      rps: r.throughputRps,
      p50: r.latencyMs.p50,
      p95: r.latencyMs.p95,
      p99: r.latencyMs.p99,
      'err%': r.errorRatePct,
      lockConflicts: r.lockConflicts,
      outboxMaxLagS: r.outboxMaxLagS,
    })),
  );
  console.log(JSON.stringify(report.finalConsistency, null, 2));
  console.log('Relatório salvo em load-test/results.json');
  if (inconsistent.length > 0) process.exit(1);
}

await main();
