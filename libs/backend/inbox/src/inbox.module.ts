import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SourcePayloadEntity,
} from '@plaudern/persistence';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InboxItemEntity,
      SourcePayloadEntity,
      ExtractedPayloadEntity,
    ]),
  ],
  providers: [InboxService],
  controllers: [InboxController],
  exports: [InboxService],
})
export class InboxModule {}
