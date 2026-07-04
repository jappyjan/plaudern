import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ConnectionOptions } from 'bullmq';
import { InboxModule } from '@plaudern/inbox';
import { SpeakerOccurrenceEntity } from '@plaudern/persistence';
import { SUMMARIZATION_PROVIDER } from './summarization.provider';
import { SUMMARIZATION_QUEUE } from './summarization.job';
import { OpenAiSummarizationProvider } from './providers/openai.provider';
import { SummaryContextService } from './summary-context.service';
import { SummarizationProcessor } from './summarization.processor';
import { SummarizationService } from './summarization.service';
import { SummarizationController } from './summarization.controller';
import { SummarizationTrigger } from './summarization.trigger';
import { InlineSummarizationQueue } from './queues/inline.queue';
import { BullSummarizationQueue } from './queues/bull.queue';

function redisConnection(config: ConfigService): ConnectionOptions {
  const url = config.get<string>('REDIS_URL');
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || '6379'),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    };
  }
  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: Number(config.get<string>('REDIS_PORT', '6379')),
  };
}

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([SpeakerOccurrenceEntity]),
  ],
  providers: [
    OpenAiSummarizationProvider,
    // Only one provider for now (any OpenAI-compatible endpoint, DeepSeek by
    // default); the token keeps the seam for future providers and test fakes.
    {
      provide: SUMMARIZATION_PROVIDER,
      inject: [OpenAiSummarizationProvider],
      useFactory: (openai: OpenAiSummarizationProvider) => openai,
    },
    SummaryContextService,
    SummarizationProcessor,
    {
      provide: SUMMARIZATION_QUEUE,
      inject: [ConfigService, SummarizationProcessor],
      useFactory: (config: ConfigService, processor: SummarizationProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullSummarizationQueue(redisConnection(config), processor)
          : new InlineSummarizationQueue(processor),
    },
    SummarizationService,
    SummarizationTrigger,
  ],
  controllers: [SummarizationController],
  exports: [SummarizationService],
})
export class SummarizationModule {}
