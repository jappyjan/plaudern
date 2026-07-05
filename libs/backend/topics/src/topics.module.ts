import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { EmbeddingModule } from '@plaudern/embeddings';
import {
  InboxItemEntity,
  ItemTopicEntity,
  TopicEntity,
  TopicProposalEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TOPIC_CLASSIFICATION_PROVIDER } from './topics.provider';
import { TOPIC_PROPOSAL_LABEL_PROVIDER } from './topic-proposals.provider';
import { TOPICS_QUEUE } from './topics.job';
import { OpenAiTopicClassificationProvider } from './providers/openai.provider';
import { OpenAiTopicProposalLabelProvider } from './providers/openai.labeler';
import { TopicsProcessor } from './topics.processor';
import { TopicsService } from './topics.service';
import { TopicProposalsService } from './topic-proposals.service';
import { TopicsExtractor } from './topics.extractor';
import { ItemTopicsController, TopicsController } from './topics.controller';
import { TopicProposalsController } from './topic-proposals.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    // Read-only use of stored embeddings (item centroids) for cluster proposals.
    EmbeddingModule,
    TypeOrmModule.forFeature([TopicEntity, ItemTopicEntity, InboxItemEntity, TopicProposalEntity]),
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
  ],
  controllers: [TopicsController, ItemTopicsController, TopicProposalsController],
  exports: [TopicsService, TopicsExtractor],
})
export class TopicsModule {}
