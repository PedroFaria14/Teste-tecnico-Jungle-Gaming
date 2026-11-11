import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { openApiDocument } from './http/openapi';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { HttpErrorFilter } from './http/error-filter';
import { logger, NestJsonLogger } from './shared/observability/logger';

export async function bootstrap(port = loadConfig().port) {
  const app = await NestFactory.create(AppModule, { logger: new NestJsonLogger() });
  app.useGlobalFilters(new HttpErrorFilter());
  // Documentação interativa em /docs (Swagger UI).
  SwaggerModule.setup('docs', app, openApiDocument);
  // SIGTERM/SIGINT → hooks de shutdown → workers terminam o que estão fazendo.
  app.enableShutdownHooks();
  await app.listen(port);
  logger.info('application started', { port });
  return app;
}

if (import.meta.main) {
  bootstrap().catch((error) => {
    logger.error('failed to start application', { error: (error as Error).stack ?? String(error) });
    process.exit(1);
  });
}
