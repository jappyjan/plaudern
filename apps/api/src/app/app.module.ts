import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PersistenceModule } from '@plaudern/persistence';
import { StorageModule } from '@plaudern/storage';
import { AuthModule } from '@plaudern/auth';
import { InboxModule } from '@plaudern/inbox';
import { TranscriptionModule } from '@plaudern/transcription';
import { IngestionModule } from '@plaudern/ingestion';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', 'apps/api/.env'] }),
    PersistenceModule,
    StorageModule,
    AuthModule,
    InboxModule,
    TranscriptionModule,
    IngestionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
