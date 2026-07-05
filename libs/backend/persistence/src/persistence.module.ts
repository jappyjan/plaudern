import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AuthSessionEntity,
  CalendarEventEntity,
  CalendarFeedEntity,
  ChatConversationEntity,
  ChatMessageEntity,
  CommitmentEntity,
  ConsentSettingsEntity,
  DecisionEntity,
  DocumentMetadataEntity,
  EmailSettingsEntity,
  EmbeddingChunkEntity,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  ExtractionRunEntity,
  GeocodeCacheEntity,
  InboxItemEntity,
  InboxTombstoneEntity,
  ItemTopicEntity,
  JournalDocumentEntity,
  McpTokenEntity,
  NotificationCategoryPreferenceEntity,
  NotificationDeliveryEntity,
  NotificationSettingsEntity,
  PasskeyCredentialEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  PlaudSettingsEntity,
  PushSubscriptionEntity,
  QuestionEntity,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
  ReminderEntity,
  SourcePayloadEntity,
  SpeakerOccurrenceEntity,
  SummarizationSettingsEntity,
  TaskCitationEntity,
  TaskEntity,
  TopicDocumentEntity,
  TopicEntity,
  TopicProposalEntity,
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
import { CreateNotificationTables1720000000017 } from './migrations/1720000000017-CreateNotificationTables';
import { ExtractionDag1720000000018 } from './migrations/1720000000018-ExtractionDag';
import { CreateEmbeddingChunks1720000000019 } from './migrations/1720000000019-CreateEmbeddingChunks';
import { CreateEntityRegistry1720000000020 } from './migrations/1720000000020-CreateEntityRegistry';
import { CreateTopics1720000000021 } from './migrations/1720000000021-CreateTopics';
import { CreateMcpTokens1720000000022 } from './migrations/1720000000022-CreateMcpTokens';
import { CreateEntityRelations1720000000023 } from './migrations/1720000000023-CreateEntityRelations';
import { EntityContactLinkOrigin1720000000024 } from './migrations/1720000000024-EntityContactLinkOrigin';
import { CreateCommitments1720000000025 } from './migrations/1720000000025-CreateCommitments';
import { AddFullTextSearch1720000000026 } from './migrations/1720000000026-AddFullTextSearch';
import { CreateEntityCorrections1720000000027 } from './migrations/1720000000027-CreateEntityCorrections';
import { ExtractionRunTrigger1720000000028 } from './migrations/1720000000028-ExtractionRunTrigger';
import { CreateTasks1720000000029 } from './migrations/1720000000029-CreateTasks';
import { CreateQuestions1720000000030 } from './migrations/1720000000030-CreateQuestions';
import { CreatePersonalFacts1720000000031 } from './migrations/1720000000031-CreatePersonalFacts';
import { CreateTopicProposals1720000000032 } from './migrations/1720000000032-CreateTopicProposals';
import { CreateChatTables1720000000033 } from './migrations/1720000000033-CreateChatTables';
import { AddCommitmentDuplicatesTask1720000000034 } from './migrations/1720000000034-AddCommitmentDuplicatesTask';
import { CreateDecisions1720000000035 } from './migrations/1720000000035-CreateDecisions';
import { CreateTopicDocuments1720000000036 } from './migrations/1720000000036-CreateTopicDocuments';
import { VoiceProfileSelf1720000000037 } from './migrations/1720000000037-VoiceProfileSelf';
import { CreateReminders1720000000038 } from './migrations/1720000000038-CreateReminders';
import { CreateJournalDocuments1720000000039 } from './migrations/1720000000039-CreateJournalDocuments';
import { SanitizeEntityAliases1720000000040 } from './migrations/1720000000040-SanitizeEntityAliases';
import { CreateDocumentMetadata1720000000042 } from './migrations/1720000000042-CreateDocumentMetadata';

export const ALL_ENTITIES = [
  InboxItemEntity,
  SourcePayloadEntity,
  ExtractedPayloadEntity,
  ExtractionRunEntity,
  EmbeddingChunkEntity,
  EntityRegistryEntity,
  EntityMentionEntity,
  TopicEntity,
  ItemTopicEntity,
  TopicProposalEntity,
  TopicDocumentEntity,
  JournalDocumentEntity,
  CommitmentEntity,
  QuestionEntity,
  DecisionEntity,
  ReminderEntity,
  DocumentMetadataEntity,
  TaskEntity,
  TaskCitationEntity,
  PersonalFactEntity,
  PersonalFactCitationEntity,
  ChatConversationEntity,
  ChatMessageEntity,
  EntityRelationEntity,
  EntityAliasEntity,
  EntitySuppressionEntity,
  InboxTombstoneEntity,
  PlaudSettingsEntity,
  EmailSettingsEntity,
  McpTokenEntity,
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
  NotificationSettingsEntity,
  NotificationCategoryPreferenceEntity,
  PushSubscriptionEntity,
  NotificationDeliveryEntity,
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
  CreateNotificationTables1720000000017,
  ExtractionDag1720000000018,
  CreateEmbeddingChunks1720000000019,
  CreateEntityRegistry1720000000020,
  CreateTopics1720000000021,
  CreateMcpTokens1720000000022,
  CreateEntityRelations1720000000023,
  EntityContactLinkOrigin1720000000024,
  CreateCommitments1720000000025,
  AddFullTextSearch1720000000026,
  CreateEntityCorrections1720000000027,
  ExtractionRunTrigger1720000000028,
  CreateTasks1720000000029,
  CreateQuestions1720000000030,
  CreatePersonalFacts1720000000031,
  CreateTopicProposals1720000000032,
  CreateChatTables1720000000033,
  AddCommitmentDuplicatesTask1720000000034,
  CreateDecisions1720000000035,
  CreateTopicDocuments1720000000036,
  VoiceProfileSelf1720000000037,
  CreateReminders1720000000038,
  CreateJournalDocuments1720000000039,
  SanitizeEntityAliases1720000000040,
  CreateDocumentMetadata1720000000042,
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
