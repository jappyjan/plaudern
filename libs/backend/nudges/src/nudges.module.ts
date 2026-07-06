import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { NotificationsModule } from '@plaudern/notifications';
import { CommitmentEntity, NudgeStateEntity } from '@plaudern/persistence';
import { NudgesService } from './nudges.service';
import { NudgesScheduler } from './nudges.scheduler';
import { NudgesController } from './nudges.controller';

/**
 * Commitment nudges (JJ-26). A proactive surface over the commitments (JJ-36):
 * the derived read model + user actions (NudgesService), the interval sweep that
 * fires notifications (NudgesScheduler), and the ledger-facing controller.
 *
 * Read-side over the `commitments` table (no ownership of it) plus its own
 * `nudge_state` table for fire-once + dismiss/snooze. Reuses InboxModule (item
 * transcripts + owner) and the shared NotificationsModule delivery engine.
 * Resolution detection is deterministic, so there is NO extraction pipeline,
 * queue, or external-LLM call here.
 */
@Module({
  imports: [
    ConfigModule,
    InboxModule,
    NotificationsModule,
    TypeOrmModule.forFeature([CommitmentEntity, NudgeStateEntity]),
  ],
  providers: [NudgesService, NudgesScheduler],
  controllers: [NudgesController],
  exports: [NudgesService],
})
export class NudgesModule {}
