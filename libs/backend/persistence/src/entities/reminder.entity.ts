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
import type { ReminderStatus } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One prospective-memory event pulled from a recording (JJ-25) — anything
 * anchored to a FUTURE date: "the results should be in by the 14th", a contract
 * expiry, "let's talk again next month". Produced by the `reminders` extractor
 * from the transcript; each row is a calendar-visible reminder. Relative dates
 * are resolved against the source recording's `occurredAt` and stored as an
 * absolute `dueAt` instant (ISO in a varchar, so range queries compare
 * lexicographically like calendar events).
 *
 * User-scoped and MUTABLE only in `status` — the user advances it (active →
 * done / dismissed) — so it lives OUTSIDE the immutable inbox aggregate, like a
 * decision or a registry entity. Deduped on (inboxItemId, dedupeKey) where
 * dedupeKey = normalizedTitle|dueDay, so re-runs and backfills upsert onto the
 * same row rather than duplicating; `extractionId` is repointed to the latest
 * generation on each run for provenance. Status ownership: `active` is
 * extraction-owned (a re-run reaps active rows it no longer stands behind);
 * `done` and `dismissed` are user-owned and never overwritten or reaped.
 */
@Entity({ name: 'reminders' })
@Index(['userId'])
@Index(['inboxItemId'])
@Index(['userId', 'status'])
@Index(['userId', 'dueAt'])
@Index(['inboxItemId', 'dedupeKey'], { unique: true })
export class ReminderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `reminders` extraction generation that last produced this row. */
  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** What the reminder is about. */
  @Column({ type: 'text' })
  title!: string;

  /**
   * Dedupe key: lowercased/whitespace-collapsed title + "|" + the due day
   * (YYYY-MM-DD). Two extractions of the same reminder on the same day collapse
   * onto one row; the same phrase due on a different day is a distinct reminder.
   */
  @Column({ type: 'varchar' })
  dedupeKey!: string;

  /** The resolved absolute instant the reminder is due (ISO in a varchar). */
  @Column({ type: 'varchar' })
  dueAt!: string;

  @Column({ type: 'varchar', default: 'active' })
  status!: ReminderStatus;

  /** The model's confidence in the reminder (0..1); null when not provided. */
  @Column({ type: 'float', nullable: true })
  confidence!: number | null;

  /** Segment start (seconds into the recording) the reminder was heard at. */
  @Column({ type: 'float', nullable: true })
  sourceTimestamp!: number | null;

  /** The transcript span the reminder was drawn from, for provenance. */
  @Column({ type: 'text', nullable: true })
  sourceQuote!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
