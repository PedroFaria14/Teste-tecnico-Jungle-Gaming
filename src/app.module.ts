import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { DataSource } from 'typeorm';
import { PendingReferenceService } from './application/pending-reference-service';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import type { UnitOfWork } from './application/ports';
import type { SettlementPolicy } from './domain/wager-settlement';
import { WagerQueryService, WalletService } from './application/wallet-service';
import { type AppConfig, loadConfig } from './config';
import { newId } from './domain/ids';
import { ProviderAuthGuard } from './http/auth';
import { OpsController, WageringController, WalletsController } from './http/controllers';
import { createDataSource } from './infrastructure/database/data-source';
import { PgUnitOfWork } from './infrastructure/database/unit-of-work';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { PollingLoop } from './infrastructure/messaging/polling-loop';
import { createSqsClient, ensureQueues, type QueueUrls } from './infrastructure/messaging/sqs';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { logger, runWithLogContext } from './shared/observability/logger';
import { TOKENS } from './tokens';

function referencePolicy(config: AppConfig): SettlementPolicy {
  return {
    baseDelayMs: config.pendingReference.baseDelayMs,
    maxDelayMs: config.pendingReference.maxDelayMs,
    maxAttempts: config.pendingReference.maxAttempts,
  };
}

/** Liga/desliga os processos de fundo junto com o ciclo de vida do Nest (inclui SIGTERM). */
@Injectable()
class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly loops: Pick<PollingLoop, 'start' | 'stop'>[] = [];

  constructor(
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.wagerConsumer) private readonly consumer: WagerConsumer,
    @Inject(TOKENS.outboxPublisher) private readonly outbox: OutboxPublisher,
    @Inject(TOKENS.pendingReference) private readonly pending: PendingReferenceService,
    @Inject(TOKENS.dataSource) private readonly dataSource: DataSource,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) this.consumer.start();
    if (this.config.outbox.enabled) {
      this.loops.push(new PollingLoop(
          'outbox-publisher',
          this.config.outbox.pollIntervalMs,
          () => this.outbox.publishOnce(),
          (claimed) => claimed >= this.outbox.batchSize, // lote cheio → há backlog → sem pausa
        ));
    }
    if (this.config.pendingReference.enabled) {
      this.loops.push(
        new PollingLoop('pending-reference-worker', this.config.pendingReference.pollIntervalMs, () =>
          this.pending.processDue(),
        ),
      );
    }
    this.loops.forEach((l) => l.start());
  }

  /** Para de consumir e espera o trabalho em andamento ANTES de fechar banco e SQS. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    logger.info('shutting down workers', { signal });
    await Promise.all([this.consumer.stop(), ...this.loops.map((l) => l.stop())]);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
    this.sqs.destroy();
  }
}

@Module({
  controllers: [WalletsController, WageringController, OpsController],
  providers: [
    ProviderAuthGuard,
    BackgroundWorkers,
    { provide: TOKENS.config, useFactory: loadConfig },
    {
      provide: TOKENS.dataSource,
      inject: [TOKENS.config],
      useFactory: async (config: AppConfig) => {
        const dataSource = createDataSource(config.databaseUrl, config.dbPoolSize);
        await dataSource.initialize();
        return dataSource;
      },
    },
    {
      provide: TOKENS.uow,
      inject: [TOKENS.dataSource, TOKENS.config],
      useFactory: (ds: DataSource, config: AppConfig) => new PgUnitOfWork(ds, { lockTimeoutMs: config.lockTimeoutMs }),
    },
    { provide: TOKENS.sqs, inject: [TOKENS.config], useFactory: createSqsClient },
    {
      provide: TOKENS.queueUrls,
      inject: [TOKENS.sqs, TOKENS.config],
      useFactory: (sqs: SQSClient, config: AppConfig) => ensureQueues(sqs, config),
    },
    {
      provide: TOKENS.submitWager,
      inject: [TOKENS.uow, TOKENS.config],
      useFactory: (uow: UnitOfWork, config: AppConfig) => new SubmitWagerTransaction(uow, referencePolicy(config)),
    },
    { provide: TOKENS.walletService, inject: [TOKENS.uow], useFactory: (uow: UnitOfWork) => new WalletService(uow) },
    { provide: TOKENS.wagerQueries, inject: [TOKENS.uow], useFactory: (uow: UnitOfWork) => new WagerQueryService(uow) },
    {
      provide: TOKENS.pendingReference,
      inject: [TOKENS.uow, TOKENS.config],
      useFactory: (uow: UnitOfWork, config: AppConfig) => new PendingReferenceService(uow, referencePolicy(config)),
    },
    {
      provide: TOKENS.outboxPublisher,
      inject: [TOKENS.uow, TOKENS.sqs, TOKENS.queueUrls, TOKENS.config],
      useFactory: (uow: UnitOfWork, sqs: SQSClient, queues: QueueUrls, config: AppConfig) =>
        new OutboxPublisher(uow, sqs, {
          eventsQueueUrl: queues.events,
          batchSize: config.outbox.batchSize,
          leaseMs: config.outbox.leaseMs,
        }),
    },
    {
      provide: TOKENS.wagerConsumer,
      inject: [TOKENS.sqs, TOKENS.submitWager, TOKENS.queueUrls, TOKENS.config],
      useFactory: (sqs: SQSClient, useCase: SubmitWagerTransaction, queues: QueueUrls, config: AppConfig) =>
        new WagerConsumer(sqs, useCase, {
          queueUrl: queues.wager,
          dlqUrl: queues.wagerDlq,
          consumerName: config.consumer.name,
          waitTimeSeconds: config.consumer.waitTimeSeconds,
          maxReceives: config.consumer.maxReceives,
          retryBaseSeconds: config.consumer.retryBaseSeconds,
        }),
    },
  ],
})
export class AppModule implements NestModule {
  /** Correlation id: vem do header X-Correlation-Id ou é gerado; acompanha todos os logs do request. */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: Request, res: Response, next: NextFunction) => {
        const header = req.header('x-correlation-id');
        const correlationId = header && header.length <= 200 ? header : newId();
        res.setHeader('X-Correlation-Id', correlationId);
        runWithLogContext({ correlationId }, () => next());
      })
      .forRoutes('*');
  }
}
