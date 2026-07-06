import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { FactsModule } from '@plaudern/facts';
import { CommitmentsModule } from '@plaudern/commitments';
import { QuestionsModule } from '@plaudern/questions';
import {
  EntityAliasEntity,
  EntityMentionEntity,
  EntityMergeSuggestionEntity,
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
import { ENTITY_JUDGE_PROVIDER } from './entity-judge.provider';
import { WEB_RESEARCH_PROVIDER } from './web-research.provider';
import { RELATION_EXTRACTION_PROVIDER } from './relations.provider';
import { RELATION_EXTRACTION_QUEUE } from './relations.job';
import { OpenAiEntityExtractionProvider } from './providers/openai.provider';
import { OpenAiContactResolutionProvider } from './providers/openai-contact-resolution.provider';
import { OpenAiEntityJudgeProvider } from './providers/openai-entity-judge.provider';
import { OpenAiWebResearchProvider } from './providers/openai-web-research.provider';
import { DisabledWebResearchProvider } from './providers/disabled-web-research.provider';
import { OpenAiRelationExtractionProvider } from './providers/openai-relations.provider';
import { ContactResolutionStartupService } from './contact-resolution-startup.service';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesCorrectionService } from './entities-correction.service';
import { EntityReconciliationService } from './entity-reconciliation.service';
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
    AuditModule,
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
      EntityMergeSuggestionEntity,
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
    OpenAiEntityJudgeProvider,
    OpenAiWebResearchProvider,
    DisabledWebResearchProvider,
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
    {
      provide: ENTITY_JUDGE_PROVIDER,
      inject: [OpenAiEntityJudgeProvider],
      useFactory: (openai: OpenAiEntityJudgeProvider) => openai,
    },
    // Web research is opt-in per user: callers gate on
    // `aiConfig.isEnabled(userId, 'web_research')` before invoking, and the
    // provider resolves the user's DB-backed config (returning empty when
    // unset), so the real provider can be bound unconditionally.
    {
      provide: WEB_RESEARCH_PROVIDER,
      inject: [OpenAiWebResearchProvider],
      useFactory: (openai: OpenAiWebResearchProvider) => openai,
    },
    EntitiesRegistryService,
    EntitiesCorrectionService,
    EntityReconciliationService,
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
