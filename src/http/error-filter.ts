import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { DomainConflictError, DomainValidationError, NotFoundError } from '../domain/errors';
import { TransientInfrastructureError } from '../application/ports';
import { isTransientInfraError } from '../infrastructure/database/pg-errors';
import { currentLogContext, logger } from '../shared/observability/logger';

/**
 * Mapeamento ÚNICO de erros → HTTP, usado por todos os endpoints:
 *
 * | situação                                  | status | o provedor deve...           |
 * |-------------------------------------------|--------|------------------------------|
 * | payload inválido                          | 400    | corrigir, não reenviar igual |
 * | recurso inexistente                       | 404    | corrigir                     |
 * | conflito de idempotência / duplicidade    | 409    | não reenviar                 |
 * | rejeição de regra de negócio (REJECTED)   | 422    | ler failureCode              | (resposta do controller)
 * | aceito, processamento pendente            | 202    | consultar depois             | (resposta do controller)
 * | falha transitória de infraestrutura       | 503    | reenviar a MESMA requisição  |
 * | erro inesperado                           | 500    | reenviar com cautela         |
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, code, message, details } = this.map(exception);
    if (status >= 500) {
      logger.error('request failed', { status, code, error: exception });
    } else {
      logger.info('request rejected', { status, code });
    }
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
      correlationId: currentLogContext().correlationId,
    });
  }

  private map(exception: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (exception instanceof ZodError) {
      return {
        status: 400,
        code: 'INVALID_PAYLOAD',
        message: 'request payload is invalid',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof DomainValidationError) {
      return { status: 400, code: exception.code, message: exception.message };
    }
    if (exception instanceof NotFoundError) {
      return { status: 404, code: exception.code, message: exception.message };
    }
    if (exception instanceof DomainConflictError) {
      return { status: 409, code: exception.code, message: exception.message };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // JSON malformado no corpo chega aqui como 400 do body-parser.
      const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
      return { status, code, message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError || isTransientInfraError(exception)) {
      return { status: 503, code: 'TRANSIENT_FAILURE', message: 'temporary infrastructure failure, retry later' };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'unexpected error' };
  }
}
