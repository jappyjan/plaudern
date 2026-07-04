import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailSettingsEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { IngestionModule } from '@plaudern/ingestion';
import { EmailSettingsService } from './email-settings.service';
import { EmailSettingsController } from './email-settings.controller';
import { EmailWebhookService } from './email-webhook.service';
import { EmailWebhookController } from './email-webhook.controller';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([EmailSettingsEntity]),
    InboxModule,
    IngestionModule,
  ],
  providers: [EmailSettingsService, EmailWebhookService],
  controllers: [EmailSettingsController, EmailWebhookController],
  exports: [EmailSettingsService, EmailWebhookService],
})
export class EmailIngestModule {}
