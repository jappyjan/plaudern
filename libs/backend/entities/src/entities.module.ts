import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import {
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  ExtractedPayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { ENTITY_EXTRACTION_PROVIDER } from './entities.provider';
import { ENTITY_EXTRACTION_QUEUE } from './entities.job';
import { RELATION_EXTRACTION_PROVIDER } from './relations.provider';
import { RELATION_EXTRACTION_QUEUE } from './relations.job';
import { OpenAiEntityExtractionProvider } from './providers/openai.provider';
import { OpenAiRelationExtractionProvider } from './providers/openai-relations.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityGraphService } from './entity-graph.service';
import { EntitiesProcessor } from './entities.processor';
import { EntitiesService } from './entities.service';
import { EntitiesController } from './entities.controller';
import { EntitiesExtractor } from './entities.extractor';
import { RelationsProcessor } from './relations.processor';
import { RelationsService } from './relations.service';
import { RelationsExtractor } from './relations.extractor';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      EntityRegistryEntity,
      EntityMentionEntity,
      EntityRelationEntity,
      ExtractedPayloadEntity,
      VoiceProfileEntity,
    ]),
  ],
  providers: [
    OpenAiEntityExtractionProvider,
    OpenAiRelationExtractionProvider,
    // Only one provider each for now (any OpenAI-compatible endpoint, DeepSeek
    // by default); the tokens keep the seam for future providers and test fakes.
    {
      provide: ENTITY_EXTRACTION_PROVIDER,
      inject: [OpenAiEntityExtractionProvider],
      useFactory: (openai: OpenAiEntityExtractionProvider) => openai,
    },
    {
      provide: RELATION_EXTRACTION_PROVIDER,
      inject: [OpenAiRelationExtractionProvider],
      useFactory: (openai: OpenAiRelationExtractionProvider) => openai,
    },
    EntitiesRegistryService,
    EntityGraphService,
    EntitiesProcessor,
    RelationsProcessor,
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
    {
      provide: RELATION_EXTRACTION_QUEUE,
      inject: [ConfigService, RelationsProcessor],
      useFactory: (config: ConfigService, processor: RelationsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('relations', 'extract-relations', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    EntitiesService,
    EntitiesExtractor,
    RelationsService,
    RelationsExtractor,
  ],
  controllers: [EntitiesController],
  exports: [EntitiesService, EntitiesExtractor, RelationsService, RelationsExtractor],
})
export class EntitiesModule {}
