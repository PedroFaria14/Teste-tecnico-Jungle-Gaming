/** Tokens de injeção explícitos (não dependemos de emitDecoratorMetadata para DI). */
export const TOKENS = {
  config: Symbol('CONFIG'),
  dataSource: Symbol('DATA_SOURCE'),
  uow: Symbol('UNIT_OF_WORK'),
  sqs: Symbol('SQS_CLIENT'),
  queueUrls: Symbol('QUEUE_URLS'),
  submitWager: Symbol('SUBMIT_WAGER'),
  walletService: Symbol('WALLET_SERVICE'),
  wagerQueries: Symbol('WAGER_QUERIES'),
  pendingReference: Symbol('PENDING_REFERENCE_SERVICE'),
  outboxPublisher: Symbol('OUTBOX_PUBLISHER'),
  wagerConsumer: Symbol('WAGER_CONSUMER'),
} as const;
