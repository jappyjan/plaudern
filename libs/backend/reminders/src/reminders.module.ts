import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { InboxItemEntity, ReminderEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { REMINDER_EXTRACTION_PROVIDER } from './reminders.provider';
import { REMINDERS_QUEUE } from './reminders.job';
import { OpenAiReminderExtractionProvider } from './providers/openai.provider';
import { ReminderContextService } from './reminder-context';
import { RemindersPersistenceService } from './reminders-persistence.service';
import { RemindersProcessor } from './reminders.processor';
import { RemindersService } from './reminders.service';
import { RemindersExtractor } from './reminders.extractor';
import { RemindersController } from './reminders.controller';
import { InboxRemindersController } from './inbox-reminders.controller';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    InboxModule,
    TypeOrmModule.forFeature([ReminderEntity, InboxItemEntity]),
  ],
  providers: [
    OpenAiReminderExtractionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: REMINDER_EXTRACTION_PROVIDER,
      inject: [OpenAiReminderExtractionProvider],
      useFactory: (openai: OpenAiReminderExtractionProvider) => openai,
    },
    ReminderContextService,
    // Persistence is a separate provider so the processor never needs an edge
    // back to RemindersService (service → queue → processor → service would
    // deadlock Nest's module compile).
    RemindersPersistenceService,
    RemindersProcessor,
    {
      provide: REMINDERS_QUEUE,
      inject: [ConfigService, RemindersProcessor],
      useFactory: (config: ConfigService, processor: RemindersProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'reminders',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    RemindersService,
    RemindersExtractor,
  ],
  controllers: [RemindersController, InboxRemindersController],
  // RemindersPersistenceService is exported so the docmeta lib (JJ-30/JJ-16) can
  // reuse the same dedup/upsert + user-owned-status durability when turning a
  // document's expiry/Kündigungsfrist into deadline reminders.
  exports: [RemindersService, RemindersExtractor, RemindersPersistenceService],
})
export class RemindersModule {}
