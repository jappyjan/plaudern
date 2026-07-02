import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InboxItemEntity } from './inbox-item.entity';
import { CalendarEventEntity } from './calendar-event.entity';

export type RecordingEventLinkOrigin = 'auto' | 'manual';
export type RecordingEventLinkStatus = 'active' | 'suppressed';

/**
 * Recording↔event link, kept in its own table so inbox_items stays immutable.
 * Unlinking flips status to 'suppressed' (a tombstone) instead of deleting, so
 * the auto-link pass never resurrects a link the user removed. The auto pass
 * only inserts missing pairs and only deletes active *auto* rows that no
 * longer overlap; manual and suppressed rows are never touched by sync.
 */
@Entity({ name: 'recording_event_links' })
@Index(['inboxItemId', 'calendarEventId'], { unique: true })
@Index(['calendarEventId'])
export class RecordingEventLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity | null;

  @Column({ type: 'uuid' })
  calendarEventId!: string;

  @ManyToOne(() => CalendarEventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'calendarEventId' })
  calendarEvent!: CalendarEventEntity | null;

  @Column({ type: 'varchar' })
  origin!: RecordingEventLinkOrigin;

  @Column({ type: 'varchar' })
  status!: RecordingEventLinkStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
