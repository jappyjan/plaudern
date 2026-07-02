import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  PlaudSettingsEntity,
  SourcePayloadEntity,
} from './entities';
import { InitialSchema1720000000000 } from './migrations/1720000000000-InitialSchema';
import { DropAuthTables1720000000001 } from './migrations/1720000000001-DropAuthTables';
import { CreatePlaudSettings1720000000002 } from './migrations/1720000000002-CreatePlaudSettings';

export const ALL_ENTITIES = [
  InboxItemEntity,
  SourcePayloadEntity,
  ExtractedPayloadEntity,
  PlaudSettingsEntity,
];

// Referenced as classes (not a glob) so migrations load identically under
// ts-jest, tsx, and compiled node.
export const ALL_MIGRATIONS = [
  InitialSchema1720000000000,
  DropAuthTables1720000000001,
  CreatePlaudSettings1720000000002,
];

/**
 * Wires TypeORM. Defaults to Postgres from env; when `DATABASE_DRIVER=sqlite`
 * (used by tests) it spins up an in-memory sqlite DB with schema sync so the
 * whole ingestion pipeline is exercisable without external infra (plan §6).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const driver = config.get<string>('DATABASE_DRIVER', 'postgres');
        if (driver === 'sqlite') {
          return {
            type: 'better-sqlite3' as const,
            database: config.get<string>('DATABASE_URL', ':memory:'),
            entities: ALL_ENTITIES,
            synchronize: true,
          };
        }
        return {
          type: 'postgres' as const,
          url: config.get<string>('DATABASE_URL'),
          entities: ALL_ENTITIES,
          synchronize: config.get<string>('DATABASE_SYNCHRONIZE') === 'true',
          migrationsRun: config.get<string>('DATABASE_SYNCHRONIZE') !== 'true',
          migrations: ALL_MIGRATIONS,
        };
      },
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class PersistenceModule {}
