import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import {
  DecisionEntity,
  EntityRegistryEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { DECISION_EXTRACTION_PROVIDER } from './decisions.provider';
import { DECISIONS_QUEUE } from './decisions.job';
import { OpenAiDecisionExtractionProvider } from './providers/openai.provider';
import { DecisionContextService } from './decision-context';
import { DecisionsPersistenceService } from './decisions-persistence.service';
import { DecisionsProcessor } from './decisions.processor';
import { DecisionsService } from './decisions.service';
import { DecisionsExtractor } from './decisions.extractor';
import { DecisionsController } from './decisions.controller';
import { InboxDecisionsController } from './inbox-decisions.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      DecisionEntity,
      EntityRegistryEntity,
      InboxItemEntity,
      SpeakerOccurrenceEntity,
    ]),
  ],
  providers: [
    OpenAiDecisionExtractionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: DECISION_EXTRACTION_PROVIDER,
      inject: [OpenAiDecisionExtractionProvider],
      useFactory: (openai: OpenAiDecisionExtractionProvider) => openai,
    },
    DecisionContextService,
    // Persistence is a separate provider so the processor never needs an edge
    // back to DecisionsService (service → queue → processor → service would
    // deadlock Nest's module compile).
    DecisionsPersistenceService,
    DecisionsProcessor,
    {
      provide: DECISIONS_QUEUE,
      inject: [ConfigService, DecisionsProcessor],
      useFactory: (config: ConfigService, processor: DecisionsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'decisions',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    DecisionsService,
    DecisionsExtractor,
  ],
  controllers: [DecisionsController, InboxDecisionsController],
  exports: [DecisionsService, DecisionsExtractor],
})
export class DecisionsModule {}
