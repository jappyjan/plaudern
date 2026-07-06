import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { EmbeddingModule } from '@plaudern/embeddings';
import {
  InboxItemEntity,
  ItemTopicEntity,
  TopicDocumentEntity,
  TopicEntity,
  TopicProposalEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TOPIC_CLASSIFICATION_PROVIDER } from './topics.provider';
import { TOPIC_PROPOSAL_LABEL_PROVIDER } from './topic-proposals.provider';
import { TOPIC_DOCUMENT_PROVIDER } from './topic-document.provider';
import { TOPICS_QUEUE } from './topics.job';
import { TOPIC_DOCUMENT_QUEUE } from './topic-document.job';
import { OpenAiTopicClassificationProvider } from './providers/openai.provider';
import { OpenAiTopicProposalLabelProvider } from './providers/openai.labeler';
import { OpenAiTopicDocumentProvider } from './providers/openai.document';
import { TopicsProcessor } from './topics.processor';
import { TopicsService } from './topics.service';
import { TopicProposalsService } from './topic-proposals.service';
import { TopicDocumentService } from './topic-document.service';
import { TopicDocumentProcessor } from './topic-document.processor';
import { TopicDocumentBackfillService } from './topic-document.backfill';
import { TopicsExtractor } from './topics.extractor';
import { ItemTopicsController, TopicsController } from './topics.controller';
import { TopicProposalsController } from './topic-proposals.controller';
import { TopicDocumentController } from './topic-document.controller';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    InboxModule,
    // Read-only use of stored embeddings (item centroids) for cluster proposals.
    EmbeddingModule,
    TypeOrmModule.forFeature([
      TopicEntity,
      ItemTopicEntity,
      InboxItemEntity,
      TopicProposalEntity,
      TopicDocumentEntity,
    ]),
  ],
  providers: [
    OpenAiTopicClassificationProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: TOPIC_CLASSIFICATION_PROVIDER,
      inject: [OpenAiTopicClassificationProvider],
      useFactory: (openai: OpenAiTopicClassificationProvider) => openai,
    },
    OpenAiTopicProposalLabelProvider,
    {
      provide: TOPIC_PROPOSAL_LABEL_PROVIDER,
      inject: [OpenAiTopicProposalLabelProvider],
      useFactory: (openai: OpenAiTopicProposalLabelProvider) => openai,
    },
    TopicsProcessor,
    {
      provide: TOPICS_QUEUE,
      inject: [ConfigService, TopicsProcessor],
      useFactory: (config: ConfigService, processor: TopicsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('topics', 'classify', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    TopicsService,
    TopicProposalsService,
    TopicsExtractor,
    // Living topic documents (JJ-12): its own generation provider, queue,
    // service, processor and startup backfill — a per-topic generation kind.
    OpenAiTopicDocumentProvider,
    {
      provide: TOPIC_DOCUMENT_PROVIDER,
      inject: [OpenAiTopicDocumentProvider],
      useFactory: (openai: OpenAiTopicDocumentProvider) => openai,
    },
    TopicDocumentProcessor,
    {
      provide: TOPIC_DOCUMENT_QUEUE,
      inject: [ConfigService, TopicDocumentProcessor],
      useFactory: (config: ConfigService, processor: TopicDocumentProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'topic-documents',
              'generate',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 1, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    TopicDocumentService,
    TopicDocumentBackfillService,
  ],
  controllers: [
    TopicsController,
    ItemTopicsController,
    TopicProposalsController,
    TopicDocumentController,
  ],
  exports: [TopicsService, TopicsExtractor, TopicDocumentService],
})
export class TopicsModule {}
