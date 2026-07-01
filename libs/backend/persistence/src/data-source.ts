import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES, ALL_MIGRATIONS } from './persistence.module';

/**
 * Standalone DataSource for the TypeORM CLI (migration generate/run).
 * Reads DATABASE_URL from the environment. See `nx run api:migrate`.
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://plaudern:plaudern@localhost:5432/plaudern',
  entities: ALL_ENTITIES,
  migrations: ALL_MIGRATIONS,
});
