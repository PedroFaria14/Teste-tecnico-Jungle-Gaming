import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';

/** Campos de correlação que acompanham todos os logs de um request/mensagem. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** Acrescenta campos ao contexto atual (ex.: transactionId depois que ele é gerado). */
export function enrichLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const instance = process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? `instance-${process.pid}`;

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const line = {
    level,
    time: new Date().toISOString(),
    instance,
    msg,
    ...storage.getStore(),
    ...fields,
  };
  const out = JSON.stringify(line, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message };
    return value;
  });
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

/**
 * Logger JSON estruturado. Regra: nunca logar payload financeiro completo nem dados do jogador
 * além de IDs — só identificadores, status e códigos.
 */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

/** Adapta o logger para os logs internos do NestJS. */
export class NestJsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    write('info', String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    write('error', String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    write('warn', String(message), { context });
  }
  debug(message: unknown, context?: string) {
    write('debug', String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    write('debug', String(message), { context });
  }
}
