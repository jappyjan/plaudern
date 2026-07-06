import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import {
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { FACT_EXTRACTION_PROVIDER } from './facts.provider';
import { FACT_EXTRACTION_QUEUE } from './facts.job';
import { OpenAiFactExtractionProvider } from './providers/openai.provider';
import { FactsRegistryService } from './facts-registry.service';
import { FactsProcessor } from './facts.processor';
import { FactsService } from './facts.service';
import { FactsExtractor } from './facts.extractor';
import { FactsController, InboxFactsController } from './facts.controller';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    InboxModule,
    TypeOrmModule.forFeature([
      PersonalFactEntity,
      PersonalFactCitationEntity,
      ExtractedPayloadEntity,
      EntityRegistryEntity,
    ]),
  ],
  providers: [
    OpenAiFactExtractionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint, DeepSeek by default); the token keeps the seam for future
    // providers and test fakes.
    {
      provide: FACT_EXTRACTION_PROVIDER,
      inject: [OpenAiFactExtractionProvider],
      useFactory: (openai: OpenAiFactExtractionProvider) => openai,
    },
    // Persistence is a separate provider so the processor never needs an edge
    // back to FactsService (service → queue → processor → service would deadlock
    // Nest's module compile).
    FactsRegistryService,
    FactsProcessor,
    {
      provide: FACT_EXTRACTION_QUEUE,
      inject: [ConfigService, FactsProcessor],
      useFactory: (config: ConfigService, processor: FactsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('facts', 'extract-facts', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    FactsService,
    FactsExtractor,
  ],
  controllers: [FactsController, InboxFactsController],
  exports: [FactsService, FactsExtractor, FactsRegistryService],
})
export class FactsModule {}
