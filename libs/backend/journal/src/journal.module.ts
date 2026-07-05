import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CalendarEventEntity,
  InboxItemEntity,
  JournalDocumentEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { JOURNAL_PROVIDER } from './journal.provider';
import { JOURNAL_QUEUE } from './journal.job';
import { OpenAiJournalProvider } from './providers/openai.journal';
import { JournalProcessor } from './journal.processor';
import { JournalService } from './journal.service';
import { JournalScheduler } from './journal.scheduler';
import { JournalController } from './journal.controller';

/**
 * Auto-journal (JJ-17): its own composition provider, queue, service, processor,
 * evening scheduler and controller. Ships disabled until JOURNAL_API_KEY (or the
 * summarization key) is configured.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([JournalDocumentEntity, InboxItemEntity, CalendarEventEntity]),
  ],
  providers: [
    OpenAiJournalProvider,
    {
      // Only one provider for now (any OpenAI-compatible /chat/completions
      // endpoint); the token keeps the seam for future providers and test fakes.
      provide: JOURNAL_PROVIDER,
      inject: [OpenAiJournalProvider],
      useFactory: (openai: OpenAiJournalProvider) => openai,
    },
    JournalProcessor,
    {
      provide: JOURNAL_QUEUE,
      inject: [ConfigService, JournalProcessor],
      useFactory: (config: ConfigService, processor: JournalProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('journal', 'compose', redisConnectionFromConfig(config), processor, {
              concurrency: 1,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    JournalService,
    JournalScheduler,
  ],
  controllers: [JournalController],
  exports: [JournalService],
})
export class JournalModule {}
