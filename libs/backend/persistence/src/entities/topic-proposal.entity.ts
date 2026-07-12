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
import type { TopicProposalStatus } from '@plaudern/contracts';
import { TopicEntity } from './topic.entity';

/**
 * A proposed taxonomy extension from an embedding cluster (JJ-64). A recurring/
 * on-demand job clusters recent items' embeddings, labels each cluster with the
 * LLM, and stores the suggestion here so the topics UI can offer one-tap accept.
 *
 * Like topics, this is mutable configuration (status transitions), so it lives
 * outside the immutable inbox aggregate. `fingerprint` is a stable hash of the
 * cluster's member ids; together with the retained dismissed/accepted rows it
 * lets the generator suppress clusters the user already ruled on rather than
 * re-proposing them endlessly.
 */
@Entity({ name: 'topic_proposals' })
@Index(['userId'])
@Index(['userId', 'status'])
// Unique so two concurrent generate runs can't store the same cluster twice;
// the losing insert catches the violation and skips (same race-recovery
// pattern as the commitments/tasks persistence).
@Index(['userId', 'fingerprint'], { unique: true })
// Supports the retention query (JJ-69): "newest N resolved rows per user" for
// the suppression set, and the prune that keeps the history bounded.
@Index(['userId', 'status', 'createdAt'])
export class TopicProposalEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Stable hash of the sorted member item ids — identifies "this cluster". */
  @Column({ type: 'varchar' })
  fingerprint!: string;

  /** LLM-suggested topic name. */
  @Column({ type: 'varchar' })
  label!: string;

  /** LLM-suggested one-line description, when available. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'int' })
  itemCount!: number;

  /** All member inbox item ids — the set reclassified on accept. */
  @Column({ type: 'simple-json' })
  memberItemIds!: string[];

  /** A representative subset of member ids, for the UI preview. */
  @Column({ type: 'simple-json' })
  sampleItemIds!: string[];

  /**
   * The cluster's mean (L2-normalized) embedding at proposal time (JJ-69). Used
   * to suppress a dismissed cluster that REGREW: member-id Jaccard alone misses
   * a cluster that more-than-doubled, but its centroid barely moves, so a fresh
   * cluster whose centroid cosine-matches a dismissed one is suppressed too.
   * Null on legacy rows created before this column existed — those fall back to
   * Jaccard-only suppression.
   */
  @Column({ type: 'simple-json', nullable: true })
  centroid!: number[] | null;

  @Column({ type: 'varchar', default: 'pending' })
  status!: TopicProposalStatus;

  /**
   * The taxonomy topic created on accept, else null. FK to `topics` with
   * ON DELETE SET NULL (JJ-69): deleting an accepted topic clears this rather
   * than leaving a dangling id.
   */
  @ManyToOne(() => TopicEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'acceptedTopicId' })
  acceptedTopic?: TopicEntity | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedTopicId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
