import type { DataSource, QueryRunner } from 'typeorm';
import {
  ConcurrencyConflictError,
  type Repositories,
  TransientInfrastructureError,
  type UnitOfWork,
} from '../../application/ports';
import { logger } from '../../shared/observability/logger';
import { metrics } from '../../shared/observability/metrics';
import { constraintOf, isLockConflict, isTransientInfraError, isUniqueViolation } from './pg-errors';
import { createRepositories } from './repositories';

export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

/** Executor de SQL mínimo, interno à infraestrutura (a aplicação nunca vê SQL). */
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
}

class QueryRunnerSql implements Sql {
  constructor(private readonly runner: QueryRunner) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.runner.query(sql, params, true);
    return { rows: (result.records ?? []) as T[], rowCount: result.affected ?? 0 };
  }
}

/** Constraints cuja violação significa "outra instância chegou primeiro": repetir cai no replay. */
const RACE_CONSTRAINTS = new Set([
  'uq_wager_tx_idempotency_key',
  'uq_wager_tx_provider_external',
  'uq_wager_tx_single_reversal',
  'inbox_messages_pkey',
]);

function isRace(error: unknown): boolean {
  if (error instanceof ConcurrencyConflictError || isLockConflict(error)) {
    metrics.lockConflictsTotal.inc();
    return true;
  }
  if (isUniqueViolation(error)) {
    const constraint = constraintOf(error);
    return constraint !== undefined && RACE_CONSTRAINTS.has(constraint);
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ADAPTADOR PostgreSQL da porta UnitOfWork.
 *
 * - `transaction`: transação READ COMMITTED com `lock_timeout`; todos os repositórios entregues ao
 *   `work` compartilham a MESMA conexão → ou tudo faz commit, ou nada é gravado.
 * - Corridas entre instâncias são re-tentadas com limite (cada tentativa = transação nova).
 * - Esgotado o limite, ou se o banco estiver indisponível: `TransientInfrastructureError`.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly dataSource: DataSource,
    private readonly options: { lockTimeoutMs: number; maxAttempts?: number },
  ) {}

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runInTransaction(work);
      } catch (error) {
        if (isRace(error)) {
          if (attempt >= maxAttempts) throw new TransientInfrastructureError(error);
          metrics.retriesTotal.inc({ where: 'unit_of_work' });
          logger.debug('retrying transaction after concurrency race', { attempt, error: (error as Error).message });
          await sleep(Math.floor(Math.random() * 20 * attempt) + 5);
          continue;
        }
        throw this.translate(error);
      }
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      return await work(createRepositories(new QueryRunnerSql(runner)));
    } catch (error) {
      throw this.translate(error);
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async runInTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction('READ COMMITTED');
      const sql = new QueryRunnerSql(runner);
      // Evita esperar para sempre pelo lock de uma wallet: vira 55P03 → retry → 503.
      await sql.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(this.options.lockTimeoutMs))}ms'`);
      const result = await work(createRepositories(sql));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private translate(error: unknown): unknown {
    return isTransientInfraError(error) ? new TransientInfrastructureError(error) : error;
  }
}
