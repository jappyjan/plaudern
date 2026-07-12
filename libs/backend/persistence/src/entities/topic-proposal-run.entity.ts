import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ExtractionStatus } from '@plaudern/contracts';

/**
 * The state of a user's taxonomy-proposal generation (JJ-69). Generation was
 * moved off the request path onto the queue/worker: labeling up to N clusters
 * with inline LLM calls could take minutes and time out behind a proxy, so
 * `POST /topics/proposals/generate` now enqueues a run and returns immediately
 * while the UI polls.
 *
 * Exactly ONE row per user (the `userId` unique index): the row's `status`
 * cycles queued -> processing -> succeeded/failed and is the double-click guard.
 * A fresh generate is admitted only by a race-safe conditional flip out of a
 * terminal state (`UPDATE ... WHERE userId=? AND status IN ('succeeded','failed')`),
 * so two concurrent triggers coalesce onto one in-flight run instead of
 * enqueuing duplicates. Reuses the extraction status vocabulary.
 */
@Entity({ name: 'topic_proposal_runs' })
@Index(['userId'], { unique: true })
export class TopicProposalRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Generation lifecycle, reusing the extraction status vocabulary. */
  @Column({ type: 'varchar', default: 'queued' })
  status!: ExtractionStatus;

  /** Failure reason when `status` is 'failed'; null otherwise. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** How many proposals the latest completed run created, for the UI/logging. */
  @Column({ type: 'int', default: 0 })
  proposalsCreated!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
