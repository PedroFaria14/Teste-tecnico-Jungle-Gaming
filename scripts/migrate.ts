/**
 * Uso:
 *   bun run migration:run      → aplica as migrations pendentes
 *   bun run migration:revert   → desfaz a última migration
 */
import { loadConfig } from '../src/config';
import { createDataSource } from '../src/infrastructure/database/data-source';
import { isTransientInfraError } from '../src/infrastructure/database/pg-errors';

const command = process.argv[2] ?? 'run';
const dataSource = createDataSource(loadConfig().databaseUrl, 2);

// O banco pode ainda estar subindo (ex.: 57P03 no primeiro start do container): tenta por até ~30s.
for (let attempt = 1; ; attempt++) {
  try {
    await dataSource.initialize();
    break;
  } catch (error) {
    if (attempt >= 15 || !isTransientInfraError(error)) throw error;
    console.log(`database not ready yet (${(error as Error).message}); retrying in 2s [${attempt}/15]`);
    await Bun.sleep(2_000);
  }
}
try {
  if (command === 'revert') {
    await dataSource.undoLastMigration({ transaction: 'each' });
    console.log('reverted last migration');
  } else {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    console.log(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ') || '-'}`);
  }
} finally {
  await dataSource.destroy();
}
