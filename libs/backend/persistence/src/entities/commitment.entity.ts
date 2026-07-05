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
import type { CommitmentDirection, CommitmentStatus } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One promissory commitment pulled from a recording (JJ-36) — either something
 * the owner owes the counterparty (`owed_by_me`) or something the counterparty
 * owes the owner (`owed_to_me`). Produced by the `commitments` extractor from
 * the speaker-attributed transcript; the `dueDate` is resolved to an absolute
 * instant in the extractor from relative language ("by Friday") using the
 * item's `occurredAt` as the anchor.
 *
 * User-scoped and MUTABLE — the user advances `status` (open → fulfilled /
 * dismissed) — so it lives OUTSIDE the immutable inbox aggregate, like a voice
 * profile or a registry entity. Deduped on (inboxItemId, direction,
 * normalizedDescription) so re-runs and backfills upsert onto the same row
 * (preserving the user's status) rather than duplicating; `extractionId` is
 * repointed to the latest generation on each run for provenance.
 */
@Entity({ name: 'commitments' })
@Index(['userId'])
@Index(['inboxItemId'])
@Index(['userId', 'direction', 'status'])
@Index(['inboxItemId', 'direction', 'normalizedDescription'], { unique: true })
export class CommitmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `commitments` extraction generation that last produced this row. */
  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  @Column({ type: 'varchar' })
  direction!: CommitmentDirection;

  /** The other party's display name as spoken; empty string when unknown. */
  @Column({ type: 'varchar', default: '' })
  counterpartyName!: string;

  /**
   * Linked registry `person` entity id when the counterparty name confidently
   * matches a known entity; null otherwise. A loose reference (no FK) so the
   * commitments module stays decoupled from the entity registry — mirroring how
   * a voice profile / embedding chunk carries a bare id.
   */
  @Column({ type: 'uuid', nullable: true })
  counterpartyEntityId!: string | null;

  /** What was promised (the obligation). */
  @Column({ type: 'text' })
  description!: string;

  /** Lowercased/whitespace-collapsed description — the dedupe key. */
  @Column({ type: 'varchar' })
  normalizedDescription!: string;

  /**
   * Absolute due instant resolved from the source phrase; null when none.
   * Stored as an ISO 8601 UTC string (like `inbox_items.occurredAt`) so the
   * column type is portable across the Postgres and better-sqlite3 drivers.
   */
  @Column({ type: 'varchar', nullable: true })
  dueDate!: string | null;

  @Column({ type: 'varchar', default: 'open' })
  status!: CommitmentStatus;

  /** Segment start (seconds into the recording) the commitment was heard at. */
  @Column({ type: 'float', nullable: true })
  sourceTimestamp!: number | null;

  /** The transcript span the commitment was drawn from, for provenance. */
  @Column({ type: 'text', nullable: true })
  sourceQuote!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
