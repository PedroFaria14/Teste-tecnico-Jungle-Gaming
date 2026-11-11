import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Especificação OpenAPI escrita à mão. Os contratos são validados com zod (não com classes DTO
 * decoradas), então o documento é mantido aqui, ao lado dos controllers. Servida em /docs.
 */
const money = {
  type: 'object',
  required: ['amount', 'currency'],
  properties: {
    amount: { type: 'string', example: '25.00', description: 'Decimal com até 2 casas (string, nunca number)' },
    currency: { type: 'string', example: 'BRL', description: 'ISO-4217' },
  },
};

const error = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
    },
    correlationId: { type: 'string' },
  },
};

const submission = {
  type: 'object',
  properties: {
    transactionId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'] },
    balance: { $ref: '#/components/schemas/Money' },
    failureCode: { type: 'string', example: 'INSUFFICIENT_FUNDS' },
    idempotentReplay: { type: 'boolean' },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const walletIdParam = {
  name: 'walletId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Jungle Gaming — Wagering Service',
    version: '1.0.0',
    description:
      'Processamento distribuído de apostas com idempotência persistente, lock por wallet, ledger imutável, inbox/outbox e SQS.\n\n' +
      '**Dica:** crie uma wallet em `POST /wallets`, copie o `id` e use-o como `walletId` nas transações. ' +
      'O mesmo `playerId` só pode ter uma wallet por moeda.',
  },
  tags: [
    { name: 'Wallets' },
    { name: 'Wagering' },
    { name: 'Operations', description: 'Health checks e métricas (sem autenticação)' },
  ],
  components: {
    schemas: {
      Money: money,
      Error: error,
      Submission: submission,
      Wallet: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          playerId: { type: 'string', format: 'uuid' },
          balance: { $ref: '#/components/schemas/Money' },
          version: { type: 'integer', example: 1 },
        },
      },
    },
  },
  paths: {
    '/wallets': {
      post: {
        tags: ['Wallets'],
        summary: 'Cria wallet (saldo inicial gera OPENING + CREDIT no ledger)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['playerId', 'initialBalance'],
                properties: {
                  playerId: { type: 'string', format: 'uuid' },
                  initialBalance: { $ref: '#/components/schemas/Money' },
                },
              },
              example: {
                playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
                initialBalance: { amount: '100.00', currency: 'BRL' },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Criada', content: { 'application/json': { schema: { $ref: '#/components/schemas/Wallet' } } } },
          '400': errorResponse('Payload inválido'),
          '409': errorResponse('WALLET_ALREADY_EXISTS (mesmo player + moeda)'),
        },
      },
    },
    '/wallets/{walletId}': {
      get: {
        tags: ['Wallets'],
        summary: 'Consulta wallet',
        parameters: [walletIdParam],
        responses: { '200': { description: 'OK' }, '404': errorResponse('Não encontrada') },
      },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        tags: ['Wallets'],
        summary: 'Ledger paginado (cursor opaco e estável)',
        parameters: [
          walletIdParam,
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 200 } },
        ],
        responses: { '200': { description: '{ items, nextCursor }' }, '404': errorResponse('Não encontrada') },
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        tags: ['Wallets'],
        summary: 'Compara saldo armazenado com saldo reconstruído pelo ledger',
        parameters: [walletIdParam],
        responses: { '200': { description: '{ storedBalance, calculatedBalance, difference, consistent, checkedEntries }' } },
      },
    },
    '/wagering/transactions': {
      post: {
        tags: ['Wagering'],
        summary: 'Submete transação (BET, WIN, LOSS, REFUND, ROLLBACK)',
        description:
          'Reenviar a mesma requisição com a mesma `Idempotency-Key` devolve o resultado original (`idempotentReplay: true`). ' +
          'Mesma key com payload diferente → 409.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', example: 'provider-a:transaction-123' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'],
                properties: {
                  providerId: { type: 'string' },
                  externalTransactionId: { type: 'string' },
                  playerId: { type: 'string', format: 'uuid' },
                  walletId: { type: 'string', format: 'uuid' },
                  roundId: { type: 'string' },
                  gameId: { type: 'string' },
                  kind: { type: 'string', enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
                  money: { $ref: '#/components/schemas/Money' },
                  referenceExternalTransactionId: {
                    type: 'string',
                    description: 'Obrigatório para REFUND/ROLLBACK; opcional para WIN',
                  },
                },
              },
              example: {
                providerId: 'provider-a',
                externalTransactionId: 'transaction-123',
                playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
                walletId: 'COLE-AQUI-O-ID-DA-WALLET',
                roundId: 'round-987',
                gameId: 'fortune-chimp',
                kind: 'BET',
                money: { amount: '80.00', currency: 'BRL' },
              },
            },
          },
        },
        responses: {
          '201': { description: 'PROCESSED', content: { 'application/json': { schema: { $ref: '#/components/schemas/Submission' } } } },
          '200': { description: 'Replay idempotente' },
          '202': { description: 'PENDING_REFERENCE — aceita, aguardando a transação referenciada' },
          '400': errorResponse('Payload inválido'),
          '404': errorResponse('Wallet não encontrada'),
          '409': errorResponse('Conflito de idempotência'),
          '422': { description: 'REJECTED por regra de negócio (ver failureCode)' },
          '503': errorResponse('Falha transitória — pode reenviar a mesma requisição'),
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: {
        tags: ['Wagering'],
        summary: 'Consulta transação pelo id interno',
        parameters: [{ name: 'transactionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, '404': errorResponse('Não encontrada') },
      },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        tags: ['Wagering'],
        summary: 'Consulta transação pelo id do provedor',
        parameters: [
          { name: 'providerId', in: 'path', required: true, schema: { type: 'string', example: 'provider-a' } },
          { name: 'externalTransactionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '404': errorResponse('Não encontrada') },
      },
    },
    '/health/live': {
      get: { tags: ['Operations'], summary: 'Liveness', responses: { '200': { description: 'Processo vivo' } } },
    },
    '/health/ready': {
      get: {
        tags: ['Operations'],
        summary: 'Readiness (PostgreSQL + SQS)',
        responses: { '200': { description: 'Pronto' }, '503': { description: 'Dependência indisponível' } },
      },
    },
    '/metrics': {
      get: { tags: ['Operations'], summary: 'Métricas Prometheus', responses: { '200': { description: 'text/plain' } } },
    },
  },
} as unknown as OpenAPIObject;
