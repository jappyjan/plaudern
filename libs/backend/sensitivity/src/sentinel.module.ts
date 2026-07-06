import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { InboxItemEntity, ItemSensitivityEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { SENTINEL_LLM_PROVIDER } from './sentinel.provider';
import { SENTINEL_QUEUE } from './sentinel.job';
import { OpenAiSentinelProvider } from './providers/openai.provider';
import { SentinelClassifier } from './sentinel.classifier';
import { SentinelContextService } from './sentinel.context';
import { SentinelPersistenceService } from './sentinel-persistence.service';
import { SentinelProcessor } from './sentinel.processor';
import { SentinelService } from './sentinel.service';
import { SentinelExtractor } from './sentinel.extractor';
import { SensitivityRoutingService } from './sensitivity-routing.service';
import { InboxSensitivityController } from './inbox-sensitivity.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([ItemSensitivityEntity, InboxItemEntity]),
  ],
  providers: [
    OpenAiSentinelProvider,
    // Only one provider for now; the token keeps the seam for future providers
    // and test fakes.
    {
      provide: SENTINEL_LLM_PROVIDER,
      inject: [OpenAiSentinelProvider],
      useFactory: (openai: OpenAiSentinelProvider) => openai,
    },
    SentinelClassifier,
    SentinelContextService,
    // Persistence is a separate provider so the processor never edges back to
    // SentinelService (service → queue → processor → service would deadlock
    // Nest's module compile).
    SentinelPersistenceService,
    SentinelProcessor,
    {
      provide: SENTINEL_QUEUE,
      inject: [ConfigService, SentinelProcessor],
      useFactory: (config: ConfigService, processor: SentinelProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'sentinel',
              'classify',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    SentinelService,
    SensitivityRoutingService,
    SentinelExtractor,
  ],
  controllers: [InboxSensitivityController],
  exports: [SentinelService, SentinelExtractor, SensitivityRoutingService],
})
export class SentinelModule {}
