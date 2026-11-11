import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { TransientInfrastructureError } from '../../src/application/ports';
import { IdempotencyConflictError } from '../../src/application/submit-wager-transaction';
import { DomainConflictError, DomainValidationError, InvalidMoneyError, NotFoundError } from '../../src/domain/errors';
import { HttpErrorFilter } from '../../src/http/error-filter';

/**
 * O mapeamento erro → status HTTP é ÚNICO para todos os endpoints (seção 9 do desafio):
 * o provedor decide se reenvia olhando só o status, sem interpretar mensagem.
 */
function capture(exception: unknown) {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as any };
  const response = {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new HttpErrorFilter().catch(exception, host);
  return res;
}

describe('mapeamento de erros HTTP', () => {
  test('payload inválido (zod) → 400 INVALID_PAYLOAD com detalhes', () => {
    const zodError = z.object({ a: z.string() }).safeParse({}).error;
    const res = capture(zodError);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    expect(res.body.error.details).toBeArray();
  });

  test('dinheiro inválido → 400 INVALID_MONEY', () => {
    expect(capture(new InvalidMoneyError('x')).statusCode).toBe(400);
    expect(capture(new DomainValidationError('REFERENCE_REQUIRED', 'x')).body.error.code).toBe('REFERENCE_REQUIRED');
  });

  test('não encontrado → 404', () => {
    expect(capture(new NotFoundError('WALLET_NOT_FOUND', 'x')).statusCode).toBe(404);
  });

  test('conflito de idempotência → 409', () => {
    const res = capture(new IdempotencyConflictError('k'));
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(capture(new DomainConflictError('WALLET_ALREADY_EXISTS', 'x')).statusCode).toBe(409);
  });

  test('falha transitória de infraestrutura → 503 + Retry-After (pode reenviar)', () => {
    const res = capture(new TransientInfrastructureError(new Error('lock timeout')));
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(res.body.error.code).toBe('TRANSIENT_FAILURE');
  });

  test('banco fora do ar (erro cru do driver) também → 503', () => {
    const pgDown = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(capture(pgDown).statusCode).toBe(503);
  });

  test('erro inesperado → 500 sem vazar detalhes internos', () => {
    const res = capture(new Error('segredo interno'));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('segredo');
  });
});
