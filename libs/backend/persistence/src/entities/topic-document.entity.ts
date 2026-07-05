import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ExtractionStatus, TopicDocumentCitation } from '@plaudern/contracts';

/**
 * One generated version of a topic's living document (JJ-12) — an evergreen,
 * self-updating Markdown write-up of a topic that regenerates whenever a new
 * item classifies into it. APPEND-ONLY: each regeneration inserts a fresh row
 * with the next `version`, so the topic's evolution stays visible as a history.
 * The CURRENT document is the highest-`version` succeeded row for the topic; a
 * queued/processing/failed newer row lets the read model show "regenerating"
 * (or a failed attempt) while the last good version stays visible.
 *
 * Like topics themselves this is a generated artifact keyed to a mutable topic,
 * so it lives outside the immutable inbox aggregate. `topicId` is a plain
 * reference (not a hard FK): deleting a topic prunes its documents explicitly
 * (or the startup sweep reaps orphans), mirroring how `item_topics` are pruned.
 *
 * `citations` is the STRUCTURAL source list (inbox item ids + optional audio
 * offsets) the body's inline `[n]` markers resolve against — the same citation
 * contract the memory chat uses, so every statement is traceable to a source.
 */
@Entity({ name: 'topic_documents' })
@Index(['userId'])
@Index(['topicId'])
@Index(['topicId', 'status'])
// One row per (topic, version): makes version numbering consistent and lets a
// racing concurrent generation recover from the unique violation.
@Index(['topicId', 'version'], { unique: true })
export class TopicDocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Denormalized owner for per-user scoping and purge. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** The topic this document describes (plain reference, pruned on delete). */
  @Column({ type: 'uuid' })
  topicId!: string;

  /** 1-based generation counter, monotonic per topic. */
  @Column({ type: 'int' })
  version!: number;

  /** Generation lifecycle, reusing the extraction status vocabulary. */
  @Column({ type: 'varchar', default: 'queued' })
  status!: ExtractionStatus;

  /** The living document body (GitHub-flavored Markdown with `[n]` markers). */
  @Column({ type: 'text', nullable: true })
  markdown!: string | null;

  /** Structural source list the `[n]` markers resolve against. */
  @Column({ type: 'simple-json', nullable: true })
  citations!: TopicDocumentCitation[] | null;

  /** How many source items this version was generated from. */
  @Column({ type: 'int', default: 0 })
  sourceItemCount!: number;

  /** Concrete model that produced the version, for provenance. */
  @Column({ type: 'varchar', nullable: true })
  model!: string | null;

  /** Failure reason when `status` is 'failed'; null otherwise. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
