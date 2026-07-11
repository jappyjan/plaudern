import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { NotificationsModule } from '@plaudern/notifications';
import { StorageModule } from '@plaudern/storage';
import {
  AiProviderCallEntity,
  DeadMansSwitchEntity,
  DeadMansSwitchReleaseEntity,
} from '@plaudern/persistence';
import { AiAuditRecorder } from './ai-audit.recorder';
import { AuditPersistenceService } from './audit-persistence.service';
import { AuditController } from './audit.controller';
import { DataSovereigntyService } from './data-sovereignty.service';
import { DataSovereigntyController } from './data-sovereignty.controller';
import { DeadMansSwitchReleaseService } from './dead-mans-switch-release.service';
import { DeadMansSwitchScheduler } from './dead-mans-switch.scheduler';

/**
 * AI-provider audit log & data-sovereignty controls (JJ-42).
 *
 * Exports `AiAuditRecorder` so every provider adapter (transcription,
 * diarization, LLM, embeddings) can record the calls it makes; the recorder
 * reads the {user, item, kind} attribution the processors set via
 * `runWithAiAudit`. Also owns the audit-log read endpoint and the
 * export/panic-delete/dead-man's-switch endpoints.
 */
@Module({
  imports: [
    ConfigModule,
    InboxModule,
    NotificationsModule,
    StorageModule,
    TypeOrmModule.forFeature([
      AiProviderCallEntity,
      DeadMansSwitchEntity,
      DeadMansSwitchReleaseEntity,
    ]),
  ],
  providers: [
    AiAuditRecorder,
    AuditPersistenceService,
    DataSovereigntyService,
    DeadMansSwitchReleaseService,
    DeadMansSwitchScheduler,
  ],
  controllers: [AuditController, DataSovereigntyController],
  exports: [AiAuditRecorder, DeadMansSwitchReleaseService],
})
export class AuditModule {}
