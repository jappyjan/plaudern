import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PersistenceModule } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { IngestionModule } from '@plaudern/ingestion';
import { PlaudApiClient } from './plaud-api.client';
import { PlaudSettingsService } from './plaud-settings.service';
import { PlaudSyncService } from './plaud-sync.service';
import { PlaudSyncScheduler } from './plaud-sync.scheduler';
import { SettingsController } from './settings.controller';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    PersistenceModule,
    InboxModule,
    IngestionModule,
  ],
  providers: [PlaudApiClient, PlaudSettingsService, PlaudSyncService, PlaudSyncScheduler],
  controllers: [SettingsController],
  exports: [PlaudSyncService, PlaudSettingsService],
})
export class PlaudSyncModule {}
