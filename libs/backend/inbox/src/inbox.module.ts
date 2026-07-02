import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SourcePayloadEntity,
} from '@plaudern/persistence';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';
import { InboxEventsService } from './inbox-events.service';
import { InboxEventsController } from './inbox-events.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InboxItemEntity,
      SourcePayloadEntity,
      ExtractedPayloadEntity,
    ]),
  ],
  providers: [InboxService, InboxEventsService],
  controllers: [InboxController, InboxEventsController],
  exports: [InboxService, InboxEventsService],
})
export class InboxModule {}
