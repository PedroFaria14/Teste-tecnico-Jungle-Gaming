/**
 * Classificação de erros vindos do PostgreSQL / driver.
 * O TypeORM embrulha o erro do `pg` em QueryFailedError com `driverError`.
 */
interface PgLikeError {
  code?: string;
  constraint?: string;
  driverError?: PgLikeError;
  message?: string;
}

function unwrap(error: unknown): PgLikeError {
  const e = (error ?? {}) as PgLikeError;
  return e.driverError ?? e;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = unwrap(error);
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function constraintOf(error: unknown): string | undefined {
  return unwrap(error).constraint;
}

/** Disputa por lock: lock_timeout, deadlock ou serialização. Vale re-tentar. */
export function isLockConflict(error: unknown): boolean {
  const code = unwrap(error).code;
  return code === '55P03' || code === '40P01' || code === '40001';
}

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/**
 * Falha transitória de infraestrutura: conexão caiu, banco reiniciando, pool esgotado, lock...
 * O mesmo pedido pode dar certo se repetido mais tarde.
 */
export function isTransientInfraError(error: unknown): boolean {
  if (isLockConflict(error)) return true;
  // Conflito de versão da wallet que sobreviveu ao retry limitado: é disputa, não bug → reenviar resolve.
  if ((error as Error)?.name === 'ConcurrencyConflictError') return true;
  const e = unwrap(error);
  const code = e.code ?? '';
  if (code.startsWith('08')) return true; // connection_exception
  if (code === '57P01' || code === '57P02' || code === '57P03') return true; // shutdown / cannot connect now
  if (code === '53300') return true; // too_many_connections
  if (TRANSIENT_NODE_CODES.has(code)) return true;
  const message = (e.message ?? (error as Error)?.message ?? '').toLowerCase();
  return (
    message.includes('connection terminated') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('connection refused') ||
    message.includes('econnrefused')
  );
}
