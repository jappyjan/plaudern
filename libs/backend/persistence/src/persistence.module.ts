import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AuthSessionEntity,
  CalendarEventEntity,
  CalendarFeedEntity,
  ConsentSettingsEntity,
  EmailSettingsEntity,
  ExtractedPayloadEntity,
  GeocodeCacheEntity,
  InboxItemEntity,
  InboxTombstoneEntity,
  PasskeyCredentialEntity,
  PlaudSettingsEntity,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
  SourcePayloadEntity,
  SpeakerOccurrenceEntity,
  SummarizationSettingsEntity,
  UserEntity,
  VoiceProfileEntity,
} from './entities';
import { InitialSchema1720000000000 } from './migrations/1720000000000-InitialSchema';
import { DropAuthTables1720000000001 } from './migrations/1720000000001-DropAuthTables';
import { CreatePlaudSettings1720000000002 } from './migrations/1720000000002-CreatePlaudSettings';
import { GeocodeCache1720000000003 } from './migrations/1720000000003-GeocodeCache';
import { CreateSpeakerTables1720000000004 } from './migrations/1720000000004-CreateSpeakerTables';
import { InboxTombstones1720000000005 } from './migrations/1720000000005-InboxTombstones';
import { CreateCalendarTables1720000000006 } from './migrations/1720000000006-CreateCalendarTables';
import { CalendarFeedAutoLink1720000000007 } from './migrations/1720000000007-CalendarFeedAutoLink';
import { CreateAuthTables1720000000008 } from './migrations/1720000000008-CreateAuthTables';
import { DeSentinelizeOwner1720000000009 } from './migrations/1720000000009-DeSentinelizeOwner';
import { PyannoteAiVoiceprints1720000000010 } from './migrations/1720000000010-PyannoteAiVoiceprints';
import { CreateSummarizationSettings1720000000011 } from './migrations/1720000000011-CreateSummarizationSettings';
import { DropEmbeddingColumns1720000000012 } from './migrations/1720000000012-DropEmbeddingColumns';
import { GoogleCalendarFeeds1720000000013 } from './migrations/1720000000013-GoogleCalendarFeeds';
import { CreateRecordingMerges1720000000014 } from './migrations/1720000000014-CreateRecordingMerges';
import { ConsentGuardian1720000000015 } from './migrations/1720000000015-ConsentGuardian';
import { CreateEmailSettings1720000000016 } from './migrations/1720000000016-CreateEmailSettings';

export const ALL_ENTITIES = [
  InboxItemEntity,
  SourcePayloadEntity,
  ExtractedPayloadEntity,
  InboxTombstoneEntity,
  PlaudSettingsEntity,
  EmailSettingsEntity,
  GeocodeCacheEntity,
  VoiceProfileEntity,
  SpeakerOccurrenceEntity,
  CalendarFeedEntity,
  CalendarEventEntity,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
  UserEntity,
  PasskeyCredentialEntity,
  AuthSessionEntity,
  SummarizationSettingsEntity,
  ConsentSettingsEntity,
];

// Referenced as classes (not a glob) so migrations load identically under
// ts-jest, tsx, and compiled node.
export const ALL_MIGRATIONS = [
  InitialSchema1720000000000,
  DropAuthTables1720000000001,
  CreatePlaudSettings1720000000002,
  GeocodeCache1720000000003,
  CreateSpeakerTables1720000000004,
  InboxTombstones1720000000005,
  CreateCalendarTables1720000000006,
  CalendarFeedAutoLink1720000000007,
  CreateAuthTables1720000000008,
  DeSentinelizeOwner1720000000009,
  PyannoteAiVoiceprints1720000000010,
  CreateSummarizationSettings1720000000011,
  DropEmbeddingColumns1720000000012,
  GoogleCalendarFeeds1720000000013,
  CreateRecordingMerges1720000000014,
  ConsentGuardian1720000000015,
  CreateEmailSettings1720000000016,
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
