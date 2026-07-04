import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One entry of a user's topic/project taxonomy (JJ-18). Mutable configuration
 * (name/description/archived), so — like summarization settings — it lives
 * outside the immutable inbox aggregate. Archiving keeps a topic's historical
 * assignments intact while removing it from future zero-shot classification.
 */
@Entity({ name: 'topics' })
@Index(['userId'])
export class TopicEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Archived topics are excluded from classification but keep their history. */
  @Column({ type: 'boolean', default: false })
  archived!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
