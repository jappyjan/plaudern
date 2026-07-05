import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { TopicProposalStatus } from '@plaudern/contracts';

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
@Index(['userId', 'fingerprint'])
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

  @Column({ type: 'varchar', default: 'pending' })
  status!: TopicProposalStatus;

  /** The taxonomy topic created on accept, else null. */
  @Column({ type: 'uuid', nullable: true })
  acceptedTopicId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
