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
import type { QuestionDirection, QuestionStatus } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One open question pulled from a recording (JJ-34) — either a question the
 * owner asked that went unanswered (`asked_by_me`) or a question asked of the
 * owner that they deferred (`asked_of_me`). Produced by the `questions`
 * extractor from the speaker-attributed transcript.
 *
 * User-scoped and MUTABLE — the user advances `status` (open → answered /
 * dropped) — so it lives OUTSIDE the immutable inbox aggregate, like a voice
 * profile or a registry entity. Deduped on (inboxItemId, direction,
 * normalizedQuestion) so re-runs and backfills upsert onto the same row rather
 * than duplicating; `extractionId` is repointed to the latest generation on
 * each run for provenance. `open`/`answered` are extraction-owned (re-derived
 * every run); a user `dropped` decision is never overwritten by the pipeline.
 */
@Entity({ name: 'questions' })
@Index(['userId'])
@Index(['inboxItemId'])
@Index(['userId', 'direction', 'status'])
@Index(['inboxItemId', 'direction', 'normalizedQuestion'], { unique: true })
export class QuestionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `questions` extraction generation that last produced this row. */
  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  @Column({ type: 'varchar' })
  direction!: QuestionDirection;

  /** The other party's display name as spoken; empty string when unknown. */
  @Column({ type: 'varchar', default: '' })
  counterpartyName!: string;

  /**
   * Linked registry `person` entity id when the counterparty name confidently
   * matches a known entity; null otherwise. A loose reference (no FK) so the
   * questions module stays decoupled from the entity registry — mirroring how
   * a commitment carries a bare counterparty id.
   */
  @Column({ type: 'uuid', nullable: true })
  counterpartyEntityId!: string | null;

  /** The question text. */
  @Column({ type: 'text' })
  question!: string;

  /** Lowercased/whitespace-collapsed question — the dedupe key. */
  @Column({ type: 'varchar' })
  normalizedQuestion!: string;

  @Column({ type: 'varchar', default: 'open' })
  status!: QuestionStatus;

  /** Segment start (seconds into the recording) the question was heard at. */
  @Column({ type: 'float', nullable: true })
  sourceTimestamp!: number | null;

  /** The transcript span the question was drawn from, for provenance. */
  @Column({ type: 'text', nullable: true })
  sourceQuote!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
