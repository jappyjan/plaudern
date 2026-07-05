import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { FactsModule } from '@plaudern/facts';
import { CommitmentsModule } from '@plaudern/commitments';
import { QuestionsModule } from '@plaudern/questions';
import {
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { ENTITY_EXTRACTION_PROVIDER } from './entities.provider';
import { ENTITY_EXTRACTION_QUEUE } from './entities.job';
import { CONTACT_RESOLUTION_PROVIDER } from './contact-resolution.provider';
import { RELATION_EXTRACTION_PROVIDER } from './relations.provider';
import { RELATION_EXTRACTION_QUEUE } from './relations.job';
import { OpenAiEntityExtractionProvider } from './providers/openai.provider';
import { OpenAiContactResolutionProvider } from './providers/openai-contact-resolution.provider';
import { OpenAiRelationExtractionProvider } from './providers/openai-relations.provider';
import { ContactResolutionStartupService } from './contact-resolution-startup.service';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesCorrectionService } from './entities-correction.service';
import { EntityContactResolverService } from './entity-contact-resolver.service';
import { EntityGraphService } from './entity-graph.service';
import { DossierService } from './dossier.service';
import { DossierController } from './dossier.controller';
import { EntitiesProcessor } from './entities.processor';
import { EntitiesService } from './entities.service';
import { EntitiesController } from './entities.controller';
import { InboxEntitiesController } from './inbox-entities.controller';
import { EntitiesExtractor } from './entities.extractor';
import { RelationsProcessor } from './relations.processor';
import { RelationsService } from './relations.service';
import { RelationsExtractor } from './relations.extractor';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    // The dossier aggregation composes these read models; importing them here
    // exposes their read services (no cycle — none imports EntitiesModule).
    FactsModule,
    CommitmentsModule,
    QuestionsModule,
    TypeOrmModule.forFeature([
      EntityRegistryEntity,
      EntityMentionEntity,
      EntityRelationEntity,
      EntityAliasEntity,
      EntitySuppressionEntity,
      ExtractedPayloadEntity,
      InboxItemEntity,
      SpeakerOccurrenceEntity,
      VoiceProfileEntity,
    ]),
  ],
  providers: [
    OpenAiEntityExtractionProvider,
    OpenAiRelationExtractionProvider,
    OpenAiContactResolutionProvider,
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
    {
      provide: CONTACT_RESOLUTION_PROVIDER,
      inject: [OpenAiContactResolutionProvider],
      useFactory: (openai: OpenAiContactResolutionProvider) => openai,
    },
    EntitiesRegistryService,
    EntitiesCorrectionService,
    EntityContactResolverService,
    ContactResolutionStartupService,
    EntityGraphService,
    DossierService,
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
  controllers: [EntitiesController, InboxEntitiesController, DossierController],
  // EntitiesRegistryService is exported so the docmeta lib (JJ-30) can reuse the
  // evidence-based resolver to create/enrich a contact from a business card.
  exports: [
    EntitiesService,
    EntitiesExtractor,
    RelationsService,
    RelationsExtractor,
    EntitiesRegistryService,
  ],
})
export class EntitiesModule {}
