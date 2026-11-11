import { DomainValidationError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-codes';
import { newId } from './ids';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export const WagerTransactionKind = {
  Opening: 'OPENING', // interno: crédito de abertura da wallet
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING', // aceita, ainda não aplicada (só existe em memória, dentro da transação SQL)
  PendingReference: 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed: 'PROCESSED', // terminal
  Rejected: 'REJECTED', // terminal
  Failed: 'FAILED', // terminal
} as const;
export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/** Kinds que um provedor pode enviar (OPENING é interno). */
export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const TERMINAL = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas (qualquer outra lança InvalidTransactionStateError):
 *
 *   PENDING           → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE → PROCESSED | REJECTED | PENDING_REFERENCE (novo agendamento) | FAILED
 *   PROCESSED | REJECTED | FAILED → (nenhuma — terminais)
 */
const ALLOWED_TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Quais kinds cada operação de reversão/ganho pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Saldo da wallet observado quando a transação foi decidida (usado no replay). */
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError('KIND_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainValidationError('KIND_NOT_ALLOWED', `unknown kind ${String(props.kind)}`);
    }
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new DomainValidationError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (
      (props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Loss) &&
      props.referenceExternalTransactionId
    ) {
      throw new DomainValidationError(
        'REFERENCE_NOT_ALLOWED',
        `${props.kind} does not accept referenceExternalTransactionId`,
      );
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new DomainValidationError('INVALID_AMOUNT', `${props.kind} amount must be greater than zero`);
    }
    return new WagerTransaction(
      newId(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.at,
      WagerTransactionStatus.Pending,
    );
  }

  /** Transação interna de crédito de abertura. Já nasce PROCESSED. */
  static opening(props: { walletId: string; playerId: string; money: Money; correlationId: string; at: Date }) {
    const id = newId();
    const tx = new WagerTransaction(
      id,
      'internal',
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      'internal',
      props.walletId,
      props.playerId,
      'opening',
      'internal',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.correlationId,
      props.at,
      WagerTransactionStatus.Pending,
    );
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições -------------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  /** Entra (ou continua) em PENDING_REFERENCE e agenda a próxima tentativa com backoff exponencial. */
  markPendingReference(now: Date, policy: RetryPolicy, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** this._referenceAttempts);
    this._referenceAttempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._resultBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio ---------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK needs the reference to know its direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move balance');
    }
  }

  /**
   * Valida se `reference` pode ser usada por esta transação.
   * Retorna o FailureCode da violação, ou undefined se estiver tudo certo.
   * (A checagem "já revertida" depende de outras linhas e é feita no use case + índice único.)
   */
  referenceViolation(reference: WagerTransaction): FailureCode | undefined {
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) return FailureCode.ReferenceKindNotAllowed;
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (this.isReversal() && !reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} cannot go from ${this._status} to ${next}`,
      );
    }
    this._status = next;
  }
}
