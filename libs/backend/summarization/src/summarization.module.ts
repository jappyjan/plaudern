import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { SpeakerOccurrenceEntity, SummarizationSettingsEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { SUMMARIZATION_PROVIDER } from './summarization.provider';
import { SUMMARIZATION_QUEUE } from './summarization.job';
import { OpenAiSummarizationProvider } from './providers/openai.provider';
import { SummaryContextService } from './summary-context.service';
import { SummarizationSettingsService } from './summarization-settings.service';
import { SummarizationProcessor } from './summarization.processor';
import { SummarizationService } from './summarization.service';
import {
  SummarizationController,
  SummarizationSettingsController,
} from './summarization.controller';
import { SummarizationTrigger } from './summarization.trigger';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([SpeakerOccurrenceEntity, SummarizationSettingsEntity]),
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
    SummarizationSettingsService,
    SummarizationProcessor,
    {
      provide: SUMMARIZATION_QUEUE,
      inject: [ConfigService, SummarizationProcessor],
      useFactory: (config: ConfigService, processor: SummarizationProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('summarization', 'summarize', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    SummarizationService,
    SummarizationTrigger,
  ],
  controllers: [SummarizationController, SummarizationSettingsController],
  exports: [SummarizationService],
})
export class SummarizationModule {}
