import type { SQSClient } from '@aws-sdk/client-sqs';
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { createWalletSchema, idempotencyKeySchema, submitWagerSchema } from '../application/contracts';
import type { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { DEFAULT_LEDGER_LIMIT, type WagerQueryService, type WalletService } from '../application/wallet-service';
import { DomainValidationError } from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { pingSqs, type QueueUrls } from '../infrastructure/messaging/sqs';
import { currentLogContext } from '../shared/observability/logger';
import { renderMetrics } from '../shared/observability/metrics';
import { TOKENS } from '../tokens';
import { ProviderAuthGuard } from './auth';
import { presentLedgerEntry, presentSubmission, presentTransaction, presentWallet } from './presenters';

const uuid = z.string().uuid();

function parseId(value: string, name: string): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw new DomainValidationError('INVALID_ID', `${name} must be a UUID`);
  return result.data;
}

function correlationId(): string {
  return currentLogContext().correlationId ?? 'unknown';
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(@Inject(TOKENS.walletService) private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = createWalletSchema.parse(body);
    const wallet = await this.wallets.create(input, correlationId());
    const { id, playerId, balance, version } = presentWallet(wallet);
    return { id, playerId, balance, version };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.wallets.get(parseId(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? DEFAULT_LEDGER_LIMIT : Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new DomainValidationError('INVALID_LIMIT', 'limit must be a positive integer');
    }
    const page = await this.wallets.ledger(parseId(walletId, 'walletId'), cursor || undefined, parsedLimit);
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return this.wallets.reconcile(parseId(walletId, 'walletId'));
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.submitWager) private readonly submitWager: SubmitWagerTransaction,
    @Inject(TOKENS.wagerQueries) private readonly queries: WagerQueryService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const keyResult = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!keyResult.success) {
      throw new DomainValidationError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required (1..255 chars)');
    }
    const command = submitWagerSchema.parse(body);
    const outcome = await this.submitWager.execute(
      { ...command, idempotencyKey: keyResult.data },
      { correlationId: correlationId() },
    );
    if (outcome.type !== 'decided') throw new Error('unexpected outcome for HTTP submission');

    const { transaction, replay } = outcome;
    res.status(statusFor(transaction.status, replay));
    return presentSubmission(transaction, replay);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    return presentTransaction(await this.queries.byId(parseId(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(await this.queries.byExternalId(providerId, externalTransactionId));
  }
}

function statusFor(status: WagerTransactionStatus, replay: boolean): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

/** Health checks e métricas: sem autenticação. */
@Controller()
export class OpsController {
  constructor(
    @Inject(TOKENS.dataSource) private readonly dataSource: DataSource,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
    @Inject(TOKENS.queueUrls) private readonly queues: QueueUrls,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      this.dataSource
        .query('SELECT 1')
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
      pingSqs(this.sqs, this.queues.wager)
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return renderMetrics();
  }
}
