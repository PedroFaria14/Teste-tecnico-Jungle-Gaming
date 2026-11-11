import { NotFoundError } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { newId } from '../domain/ids';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { logger } from '../shared/observability/logger';
import { metrics } from '../shared/observability/metrics';
import type { UnitOfWork } from './ports';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export class WalletService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação, uma transação interna OPENING
   * já PROCESSED + o lançamento CREDIT correspondente + evento na outbox.
   * Wallet duplicada (player + moeda) → DomainConflictError(WALLET_ALREADY_EXISTS) vindo do repositório.
   */
  async create(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();
    const wallet = Wallet.open({ id: newId(), playerId: input.playerId, initialBalance, at: now });

    await this.uow.transaction(async (repos) => {
      await repos.wallets.insert(wallet);
      if (!initialBalance.isPositive()) return;
      const opening = WagerTransaction.opening({
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        correlationId,
        at: now,
      });
      const entry = wallet.openingLedgerEntry(opening.id);
      await repos.transactions.insert(opening);
      await repos.ledger.insert(entry);
      // OPENING é uma transação aplicada → WagerTransactionProcessed; e mudou o saldo → WalletBalanceChanged.
      const ctx = { correlationId, at: now };
      await repos.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)));
      await repos.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)));
    });
    logger.info('wallet created', { walletId: wallet.id });
    return wallet;
  }

  async get(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw walletNotFound(walletId);
    return wallet;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageResult> {
    const safeLimit = Math.min(Math.max(1, limit), MAX_LEDGER_LIMIT);
    return this.uow.read(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) throw walletNotFound(walletId);
      const page = await repos.ledger.page(walletId, cursor, safeLimit);
      return { items: page.entries, nextCursor: page.nextCursor };
    });
  }

  /**
   * Compara o saldo materializado com a soma do ledger. A wallet fica travada contra escritas
   * (FOR SHARE) entre as duas leituras. Divergência NUNCA é corrigida automaticamente:
   * é logada, contada em métrica e devolvida com consistent=false.
   */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    return this.uow.transaction(async (repos) => {
      const wallet = await repos.wallets.lockForShare(walletId);
      if (!wallet) throw walletNotFound(walletId);
      const summary = await repos.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.total);
      const consistent = difference.isZero();

      if (!consistent) {
        metrics.reconciliationDivergencesTotal.inc();
        logger.error('wallet reconciliation divergence', {
          walletId,
          storedBalance: wallet.balance.toString(),
          calculatedBalance: summary.total.toString(),
          difference: difference.toString(),
        });
      }
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: summary.total.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: summary.count,
      };
    });
  }
}

export class WagerQueryService {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${transactionId} not found`);
    return tx;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((repos) => repos.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${providerId}:${externalTransactionId} not found`);
    }
    return tx;
  }
}

function walletNotFound(walletId: string): NotFoundError {
  return new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
}
