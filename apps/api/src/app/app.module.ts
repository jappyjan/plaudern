import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from '@plaudern/persistence';
import { StorageModule } from '@plaudern/storage';
import { AuthModule } from '@plaudern/auth';
import { InboxModule } from '@plaudern/inbox';
import { TranscriptionModule } from '@plaudern/transcription';
import { SummarizationModule } from '@plaudern/summarization';
import { ExtractionModule } from '@plaudern/extraction';
import { EmbeddingModule } from '@plaudern/embeddings';
import { EntitiesModule } from '@plaudern/entities';
import { TopicsModule } from '@plaudern/topics';
import { TasksModule } from '@plaudern/tasks';
import { IngestionModule } from '@plaudern/ingestion';
import { PlaudSyncModule } from '@plaudern/plaud-sync';
import { SpeakerIdModule } from '@plaudern/speaker-id';
import { GeocodingModule } from '@plaudern/geocoding';
import { CalendarModule } from '@plaudern/calendar';
import { EmailIngestModule } from '@plaudern/email-ingest';
import { NotificationsModule } from '@plaudern/notifications';
import { McpModule } from '@plaudern/mcp';
import { SearchModule } from '@plaudern/search';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', 'apps/api/.env'] }),
    PersistenceModule,
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
    TasksModule,
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
  ],
  controllers: [HealthController],
})
export class AppModule {}
