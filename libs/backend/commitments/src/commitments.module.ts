import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import {
  CommitmentEntity,
  EntityRegistryEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { COMMITMENT_EXTRACTION_PROVIDER } from './commitments.provider';
import { COMMITMENTS_QUEUE } from './commitments.job';
import { OpenAiCommitmentExtractionProvider } from './providers/openai.provider';
import { CommitmentContextService } from './commitment-context';
import { CommitmentsProcessor } from './commitments.processor';
import { CommitmentsService } from './commitments.service';
import { CommitmentsExtractor } from './commitments.extractor';
import { CommitmentsController } from './commitments.controller';
import { InboxCommitmentsController } from './inbox-commitments.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      CommitmentEntity,
      EntityRegistryEntity,
      InboxItemEntity,
      SpeakerOccurrenceEntity,
    ]),
  ],
  providers: [
    OpenAiCommitmentExtractionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: COMMITMENT_EXTRACTION_PROVIDER,
      inject: [OpenAiCommitmentExtractionProvider],
      useFactory: (openai: OpenAiCommitmentExtractionProvider) => openai,
    },
    CommitmentContextService,
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
