import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PersistenceModule } from '@plaudern/persistence';
import { AiConfigModule } from '@plaudern/ai-config';
import { StorageModule } from '@plaudern/storage';
import { AuthModule } from '@plaudern/auth';
import { InboxModule } from '@plaudern/inbox';
import { TranscriptionModule } from '@plaudern/transcription';
import { SummarizationModule } from '@plaudern/summarization';
import { ExtractionModule } from '@plaudern/extraction';
import { EmbeddingModule } from '@plaudern/embeddings';
import { EntitiesModule } from '@plaudern/entities';
import { TopicsModule } from '@plaudern/topics';
import { CommitmentsModule } from '@plaudern/commitments';
import { QuestionsModule } from '@plaudern/questions';
import { TasksModule } from '@plaudern/tasks';
import { FactsModule } from '@plaudern/facts';
import { DecisionsModule } from '@plaudern/decisions';
import { RemindersModule } from '@plaudern/reminders';
import { OcrModule } from '@plaudern/ocr';
import { DocMetaModule } from '@plaudern/docmeta';
import { OpenLoopsModule } from '@plaudern/open-loops';
import { NudgesModule } from '@plaudern/nudges';
import { IngestionModule } from '@plaudern/ingestion';
import { PlaudSyncModule } from '@plaudern/plaud-sync';
import { SpeakerIdModule } from '@plaudern/speaker-id';
import { GeocodingModule } from '@plaudern/geocoding';
import { CalendarModule } from '@plaudern/calendar';
import { EmailIngestModule } from '@plaudern/email-ingest';
import { NotificationsModule } from '@plaudern/notifications';
import { McpModule } from '@plaudern/mcp';
import { SearchModule } from '@plaudern/search';
import { ChatModule } from '@plaudern/chat';
import { AuditModule } from '@plaudern/audit';
import { HealthController } from './health.controller';
import { validateEnvironment } from '../config/environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', 'apps/api/.env'],
      validate: process.env.NODE_ENV === 'production' ? validateEnvironment : undefined,
    }),
    PersistenceModule,
    // Global: exposes AiConfigService + shared AI clients to every feature
    // module, and runs the one-time env→DB import for AI config.
    AiConfigModule,
    StorageModule,
    // Installs the global session guard: every route below requires a passkey
    // session unless marked @Public().
    AuthModule,
    InboxModule,
    TranscriptionModule,
    SummarizationModule,
    EmbeddingModule,
    EntitiesModule,
    TopicsModule,
    CommitmentsModule,
    QuestionsModule,
    TasksModule,
    FactsModule,
    DecisionsModule,
    RemindersModule,
    OcrModule,
    DocMetaModule,
    OpenLoopsModule,
    NudgesModule,
    ExtractionModule,
    IngestionModule,
    PlaudSyncModule,
    SpeakerIdModule,
    GeocodingModule,
    CalendarModule,
    EmailIngestModule,
    NotificationsModule,
    McpModule,
    SearchModule,
    ChatModule,
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule {
  constructor(config: ConfigService) {
    validateEnvironment({ APP_ENCRYPTION_SECRET: config.get('APP_ENCRYPTION_SECRET') });
  }
}
