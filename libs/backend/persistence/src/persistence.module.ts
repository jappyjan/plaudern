import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DeviceEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SourcePayloadEntity,
  UserEntity,
} from './entities';

export const ALL_ENTITIES = [
  UserEntity,
  DeviceEntity,
  InboxItemEntity,
  SourcePayloadEntity,
  ExtractedPayloadEntity,
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
          migrations: [__dirname + '/migrations/*.{ts,js}'],
        };
      },
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class PersistenceModule {}
