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
import { CalendarFeedEntity } from './calendar-feed.entity';

/**
 * A cached calendar event *instance* (recurring events are expanded before
 * storage). Identity across syncs is (feedId, externalUid, instanceStart), so
 * upserts keep the uuid PK — and therefore links — stable.
 *
 * All timestamps are ISO 8601 UTC varchars (from Date#toISOString), so
 * lexicographic comparison is valid on both Postgres and sqlite.
 */
@Entity({ name: 'calendar_events' })
@Index(['feedId', 'externalUid', 'instanceStart'], { unique: true })
@Index(['userId', 'startAt'])
@Index(['userId', 'endAt'])
export class CalendarEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  feedId!: string;

  @ManyToOne(() => CalendarFeedEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feedId' })
  feed!: CalendarFeedEntity | null;

  /** ICS UID (shared by every instance of a recurring series). */
  @Column({ type: 'varchar' })
  externalUid!: string;

  /**
   * The occurrence's original start (RECURRENCE-ID for overridden instances),
   * normalized to UTC — the stable per-instance discriminator.
   */
  @Column({ type: 'varchar' })
  instanceStart!: string;

  @Column({ type: 'varchar' })
  startAt!: string;

  @Column({ type: 'varchar' })
  endAt!: string;

  /** All-day events are stored as UTC midnights of their calendar dates. */
  @Column({ type: 'boolean', default: false })
  isAllDay!: boolean;

  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', nullable: true })
  location!: string | null;

  /** Original TZID, kept for display; times themselves are stored in UTC. */
  @Column({ type: 'varchar', nullable: true })
  timezone!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
