import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  InboxTombstoneEntity,
  RecordingMergeEntity,
  SourcePayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';
import { InboxEventsService } from './inbox-events.service';
import { InboxEventsController } from './inbox-events.controller';
import { OwnerEventsService } from './owner-events.service';
import { SelfProfileService } from './self-profile.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InboxItemEntity,
      SourcePayloadEntity,
      ExtractedPayloadEntity,
      InboxTombstoneEntity,
      RecordingMergeEntity,
      VoiceProfileEntity,
    ]),
  ],
  providers: [InboxService, InboxEventsService, OwnerEventsService, SelfProfileService],
  controllers: [InboxController, InboxEventsController],
  exports: [InboxService, InboxEventsService, OwnerEventsService, SelfProfileService],
})
export class InboxModule {}
