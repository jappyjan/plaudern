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
import type { DecisionStatus } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One decision pulled from a recording (JJ-33) — "we decided to go with the
 * cheaper option". Produced by the `decisions` extractor from the
 * speaker-attributed transcript. Carries the decision statement, its
 * context/reasoning, the participants involved (raw name + optional registry
 * entity link), the model's confidence, and the source segment for citation.
 * Together the rows form a searchable decision log.
 *
 * User-scoped and MUTABLE only in `status` — the user advances it (active →
 * revisited / superseded) — so it lives OUTSIDE the immutable inbox aggregate,
 * like a voice profile or a registry entity. Deduped on (inboxItemId,
 * normalizedDecision) so re-runs and backfills upsert onto the same row rather
 * than duplicating; `extractionId` is repointed to the latest generation on
 * each run for provenance. Status ownership: `active` is extraction-owned (a
 * re-run reaps active rows it no longer stands behind); `revisited` and
 * `superseded` are user-owned and never overwritten or reaped by the pipeline.
 */
@Entity({ name: 'decisions' })
@Index(['userId'])
@Index(['inboxItemId'])
@Index(['userId', 'status'])
@Index(['inboxItemId', 'normalizedDecision'], { unique: true })
export class DecisionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `decisions` extraction generation that last produced this row. */
  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** The decision statement. */
  @Column({ type: 'text' })
  decision!: string;

  /** Lowercased/whitespace-collapsed decision — the dedupe key. */
  @Column({ type: 'varchar' })
  normalizedDecision!: string;

  /** The reasoning / context behind the decision; null when none was captured. */
  @Column({ type: 'text', nullable: true })
  context!: string | null;

  /** The people involved in the decision as spoken; empty string when unknown. */
  @Column({ type: 'varchar', default: '' })
  participants!: string;

  /**
   * Linked registry `person` entity id when the participants name confidently
   * matches a known entity; null otherwise. A loose reference (no FK) so the
   * decisions module stays decoupled from the entity registry — mirroring how
   * a question carries a bare counterparty id.
   */
  @Column({ type: 'uuid', nullable: true })
  participantEntityId!: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status!: DecisionStatus;

  /** The model's confidence in the decision (0..1); null when not provided. */
  @Column({ type: 'float', nullable: true })
  confidence!: number | null;

  /** Segment start (seconds into the recording) the decision was heard at. */
  @Column({ type: 'float', nullable: true })
  sourceTimestamp!: number | null;

  /** The transcript span the decision was drawn from, for provenance. */
  @Column({ type: 'text', nullable: true })
  sourceQuote!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
