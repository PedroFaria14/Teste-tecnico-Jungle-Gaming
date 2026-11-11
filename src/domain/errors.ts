/**
 * Erros de domínio. Ficam separados em três famílias porque cada uma tem um
 * tratamento diferente nas bordas (HTTP / SQS):
 *
 * - DomainValidationError: o payload é inválido → o provedor precisa corrigir (400 / DLQ).
 * - DomainConflictError:   conflito de estado/identidade → não adianta reenviar (409 / ack).
 * - InvalidTransactionStateError: erro de PROGRAMAÇÃO (transição ilegal). Nunca é caminho de negócio.
 *
 * Rejeições de regra de negócio (saldo insuficiente, referência inválida...) NÃO são exceções:
 * elas viram uma WagerTransaction REJECTED com failureCode, porque precisam ficar auditáveis.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainValidationError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidMoneyError extends DomainValidationError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainValidationError {
  constructor(expected: string, received: string) {
    super('CURRENCY_MISMATCH', `currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class DomainConflictError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Saldo insuficiente ao tentar debitar a wallet (invariante "saldo nunca negativo"). */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(message = 'insufficient funds') {
    super(message);
  }
}

/** Tentativa de transicionar uma transação terminal — é bug, não regra de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(message: string) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
  constructor(message: string) {
    super(message);
  }
}
