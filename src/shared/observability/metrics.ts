/**
 * Registro de métricas mínimo no formato texto do Prometheus (GET /metrics).
 * Feito à mão para não depender de libs com APIs específicas de Node; é só contador,
 * gauge e histograma com labels.
 */
type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`)
    .join(',');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}
  abstract render(): string[];
}

export class Counter extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, value = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + value);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, number>();
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }
  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), value);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`);
  }
}

export class Histogram extends Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    name: string,
    help: string,
    private readonly buckets: number[],
  ) {
    super(name, help, 'histogram');
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  render(): string[] {
    const lines: string[] = [];
    for (const [k, s] of this.series) {
      const prefix = k ? `${k},` : '';
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${prefix}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines;
  }
}

const registry: Metric[] = [];
function register<T extends Metric>(metric: T): T {
  registry.push(metric);
  return metric;
}

export const metrics = {
  transactionsTotal: register(
    new Counter('wager_transactions_total', 'Transações decididas, por kind/status/failure_code'),
  ),
  duplicatesTotal: register(
    new Counter('wager_duplicates_total', 'Duplicatas detectadas (source=http_idempotency|inbox)'),
  ),
  idempotencyConflictsTotal: register(
    new Counter('wager_idempotency_conflicts_total', 'Mesma idempotency key com payload diferente'),
  ),
  inboxPayloadMismatchTotal: register(
    new Counter('wager_inbox_payload_mismatch_total', 'messageId repetido com payload diferente (anomalia)'),
  ),
  retriesTotal: register(new Counter('wager_retries_total', 'Retentativas (where=use_case|sqs|pending_reference)')),
  dlqTotal: register(new Counter('wager_dlq_messages_total', 'Mensagens enviadas para a DLQ, por motivo')),
  lockConflictsTotal: register(
    new Counter('wager_lock_conflicts_total', 'Lock timeout / deadlock / conflito de versão na wallet'),
  ),
  outboxPublishedTotal: register(new Counter('outbox_published_total', 'Eventos publicados')),
  outboxPublishFailuresTotal: register(new Counter('outbox_publish_failures_total', 'Falhas ao publicar')),
  outboxLagSeconds: register(new Gauge('outbox_lag_seconds', 'Idade do evento pendente mais antigo')),
  reconciliationDivergencesTotal: register(
    new Counter('wallet_reconciliation_divergences_total', 'Reconciliações com saldo divergente do ledger'),
  ),
  processingLatencySeconds: register(
    new Histogram('wager_processing_latency_seconds', 'Latência do processamento (source=http|sqs)', [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
    ]),
  ),
};

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const m of registry) {
    lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.render());
  }
  return lines.join('\n') + '\n';
}
