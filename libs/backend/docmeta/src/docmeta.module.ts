import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { DocumentMetadataEntity, InboxItemEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { RemindersModule } from '@plaudern/reminders';
import { EntitiesModule } from '@plaudern/entities';
import { DOCMETA_PROVIDER } from './docmeta.provider';
import { DOCMETA_QUEUE } from './docmeta.job';
import { OpenAiDocMetaProvider } from './providers/openai.provider';
import { DocMetaContextService } from './docmeta-context';
import { DocMetaPersistenceService } from './docmeta-persistence.service';
import { DocMetaProcessor } from './docmeta.processor';
import { DocMetaService } from './docmeta.service';
import { DocMetaExtractor } from './docmeta.extractor';
import { DocumentsController } from './docmeta.controller';
import { InboxDocMetaController } from './inbox-docmeta.controller';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    InboxModule,
    // Deadline reminders reuse the JJ-25 reminders persistence (dedup/upsert +
    // user-owned-status durability); business-card contacts reuse the entity
    // registry resolver. Both are acyclic imports (neither depends on docmeta).
    RemindersModule,
    EntitiesModule,
    TypeOrmModule.forFeature([DocumentMetadataEntity, InboxItemEntity]),
  ],
  providers: [
    OpenAiDocMetaProvider,
    {
      provide: DOCMETA_PROVIDER,
      inject: [OpenAiDocMetaProvider],
      useFactory: (openai: OpenAiDocMetaProvider) => openai,
    },
    DocMetaContextService,
    // Persistence is a separate provider so the processor never needs an edge
    // back to DocMetaService (service → queue → processor → service would
    // deadlock Nest's module compile).
    DocMetaPersistenceService,
    DocMetaProcessor,
    {
      provide: DOCMETA_QUEUE,
      inject: [ConfigService, DocMetaProcessor],
      useFactory: (config: ConfigService, processor: DocMetaProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'docmeta',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    DocMetaService,
    DocMetaExtractor,
  ],
  controllers: [DocumentsController, InboxDocMetaController],
  exports: [DocMetaService, DocMetaExtractor],
})
export class DocMetaModule {}
