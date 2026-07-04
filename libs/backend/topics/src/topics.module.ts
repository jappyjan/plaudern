import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { InboxItemEntity, ItemTopicEntity, TopicEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TOPIC_CLASSIFICATION_PROVIDER } from './topics.provider';
import { TOPICS_QUEUE } from './topics.job';
import { OpenAiTopicClassificationProvider } from './providers/openai.provider';
import { TopicsProcessor } from './topics.processor';
import { TopicsService } from './topics.service';
import { TopicsExtractor } from './topics.extractor';
import { ItemTopicsController, TopicsController } from './topics.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([TopicEntity, ItemTopicEntity, InboxItemEntity]),
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
    TopicsExtractor,
  ],
  controllers: [TopicsController, ItemTopicsController],
  exports: [TopicsService, TopicsExtractor],
})
export class TopicsModule {}
