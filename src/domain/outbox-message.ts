import { InvalidTransactionStateError } from './errors';
import type { IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export const OUTBOX_RETRY = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem da outbox é o próprio eventId — consumidores deduplicam por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto) */
  scheduleRetry(now: Date, policy = OUTBOX_RETRY): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** this._attempts);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
