import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { OpenAiEmbeddingProvider } from '@plaudern/embeddings';
import {
  CommitmentEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  TaskCitationEntity,
  TaskEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { COMMITMENT_EXTRACTION_PROVIDER } from './commitments.provider';
import { COMMITMENTS_QUEUE } from './commitments.job';
import { OpenAiCommitmentExtractionProvider } from './providers/openai.provider';
import { CommitmentContextService } from './commitment-context';
import { CommitmentsPersistenceService } from './commitments-persistence.service';
import {
  COMMITMENT_DEDUPE_EMBEDDING_PROVIDER,
  CommitmentTaskDedupeService,
} from './commitment-task-dedupe.service';
import { CommitmentsProcessor } from './commitments.processor';
import { CommitmentsService } from './commitments.service';
import { CommitmentsExtractor } from './commitments.extractor';
import { CommitmentsController } from './commitments.controller';
import { InboxCommitmentsController } from './inbox-commitments.controller';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    InboxModule,
    TypeOrmModule.forFeature([
      CommitmentEntity,
      EntityRegistryEntity,
      ExtractedPayloadEntity,
      InboxItemEntity,
      SpeakerOccurrenceEntity,
      TaskCitationEntity,
      TaskEntity,
    ]),
  ],
  providers: [
    OpenAiCommitmentExtractionProvider,
    // Reconciles owed_by_me commitments against the item's tasks so one
    // intention isn't shown as both a task and a commitment; reuses the shared
    // embeddings provider (EMBEDDINGS_*), exactly like the task dedupe.
    OpenAiEmbeddingProvider,
    {
      provide: COMMITMENT_DEDUPE_EMBEDDING_PROVIDER,
      inject: [OpenAiEmbeddingProvider],
      useFactory: (openai: OpenAiEmbeddingProvider) => openai,
    },
    CommitmentTaskDedupeService,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: COMMITMENT_EXTRACTION_PROVIDER,
      inject: [OpenAiCommitmentExtractionProvider],
      useFactory: (openai: OpenAiCommitmentExtractionProvider) => openai,
    },
    CommitmentContextService,
    // Persistence is a separate provider so the processor never needs an edge
    // back to CommitmentsService (service → queue → processor → service would
    // deadlock Nest's module compile).
    CommitmentsPersistenceService,
    CommitmentsProcessor,
    {
      provide: COMMITMENTS_QUEUE,
      inject: [ConfigService, CommitmentsProcessor],
      useFactory: (config: ConfigService, processor: CommitmentsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'commitments',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    CommitmentsService,
    CommitmentsExtractor,
  ],
  controllers: [CommitmentsController, InboxCommitmentsController],
  exports: [CommitmentsService, CommitmentsExtractor],
})
export class CommitmentsModule {}
