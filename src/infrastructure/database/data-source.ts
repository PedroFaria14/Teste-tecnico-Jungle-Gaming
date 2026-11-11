import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InitialSchema1762800000000 } from './migrations/1762800000000-InitialSchema';

export const MIGRATIONS = [InitialSchema1762800000000];

export function createDataSource(databaseUrl: string, poolSize = 20): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    // Não usamos entidades decoradas: o domínio é puro e o mapeamento é feito à mão
    // nos repositórios (SQL explícito deixa locks e constraints visíveis).
    entities: [],
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: false,
    extra: {
      max: poolSize,
      connectionTimeoutMillis: 5_000,
    },
  });
}
