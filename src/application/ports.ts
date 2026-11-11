import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

/**
 * PORTAS da aplicação (arquitetura hexagonal).
 *
 * A camada de aplicação só conhece estas interfaces. A implementação com PostgreSQL/TypeORM vive em
 * `infrastructure/database` e é injetada no bootstrap — trocar o banco ou usar um fake em teste
 * não exige mexer em use case nenhum.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** Trava a wallet para escrita até o fim da transação (unidade de concorrência). */
  lockForUpdate(id: string): Promise<Wallet | undefined>;
  /** Trava a wallet contra escritas, permitindo outras leituras (reconciliação). */
  lockForShare(id: string): Promise<Wallet | undefined>;
  /** Lança DomainConflictError(WALLET_ALREADY_EXISTS) se o player já tem wallet nessa moeda. */
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo/versão condicionado à versão lida; lança ConcurrencyConflictError se mudou. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockForUpdate(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  insert(tx: WagerTransaction): Promise<void>;
  updateState(tx: WagerTransaction, at: Date): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Cursor opaco para a próxima página, ou null se acabou. */
  nextCursor: string | null;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Lança DomainValidationError(INVALID_CURSOR) se o cursor não for reconhecido. */
  page(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  /** Soma assinada de todos os lançamentos (CREDIT − DEBIT) e quantidade de lançamentos. */
  summarize(walletId: string, currency: string): Promise<{ total: Money; count: number }>;
}

export interface InboxRepository {
  /** Registra a mensagem; devolve false se ela já tinha sido registrada (duplicata). */
  tryRecord(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  /** Reserva (lease) um lote de mensagens vencidas, sem bloquear outros publishers. */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  /** Marca um lote inteiro como publicado com uma única escrita. */
  markPublishedMany(messages: OutboxMessage[]): Promise<void>;
  saveRetry(message: OutboxMessage, error: string): Promise<void>;
  /** Idade em segundos do evento pendente mais antigo. */
  lagSeconds(now: Date): Promise<number>;
}

/** Repositórios ligados a UMA conexão/transação. */
export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Unidade de trabalho: tudo que é gravado dentro de `transaction` faz commit junto ou nada é gravado.
 *
 * Contrato de erros da implementação:
 * - corridas entre instâncias (lock timeout, deadlock, conflito de versão, unique de idempotência)
 *   são re-tentadas internamente, com limite;
 * - falha de infraestrutura que pode passar se repetida (banco fora, corrida que não se resolveu)
 *   sai como `TransientInfrastructureError`;
 * - erros de domínio saem intactos.
 */
export interface UnitOfWork {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** O saldo mudou entre a leitura e a escrita (defesa em profundidade além do lock). */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

/** Falha temporária de infraestrutura: repetir a MESMA operação mais tarde pode dar certo (503 / retry SQS). */
export class TransientInfrastructureError extends Error {
  constructor(override readonly cause: unknown) {
    super(`transient infrastructure failure: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'TransientInfrastructureError';
  }
}
