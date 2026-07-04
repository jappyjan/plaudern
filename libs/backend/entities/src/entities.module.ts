import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import {
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { ENTITY_EXTRACTION_PROVIDER } from './entities.provider';
import { ENTITY_EXTRACTION_QUEUE } from './entities.job';
import { OpenAiEntityExtractionProvider } from './providers/openai.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesProcessor } from './entities.processor';
import { EntitiesService } from './entities.service';
import { EntitiesController } from './entities.controller';
import { EntitiesExtractor } from './entities.extractor';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      EntityRegistryEntity,
      EntityMentionEntity,
      ExtractedPayloadEntity,
      VoiceProfileEntity,
    ]),
  ],
  providers: [
    OpenAiEntityExtractionProvider,
    // Only one provider for now (any OpenAI-compatible endpoint, DeepSeek by
    // default); the token keeps the seam for future providers and test fakes.
    {
      provide: ENTITY_EXTRACTION_PROVIDER,
      inject: [OpenAiEntityExtractionProvider],
      useFactory: (openai: OpenAiEntityExtractionProvider) => openai,
    },
    EntitiesRegistryService,
    EntitiesProcessor,
    {
      provide: ENTITY_EXTRACTION_QUEUE,
      inject: [ConfigService, EntitiesProcessor],
      useFactory: (config: ConfigService, processor: EntitiesProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('entities', 'extract-entities', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    EntitiesService,
    EntitiesExtractor,
  ],
  controllers: [EntitiesController],
  exports: [EntitiesService, EntitiesExtractor],
})
export class EntitiesModule {}
