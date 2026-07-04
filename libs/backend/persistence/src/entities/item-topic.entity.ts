import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExtractedPayloadEntity } from './extracted-payload.entity';

/**
 * One topic assigned to an inbox item by a zero-shot `topics` extraction
 * (JJ-18). The immutable record of a classification lives in the extraction
 * row's JSON `content`; this table is a latest-only projection of it, kept in
 * sync by the processor (a fresh classification replaces an item's rows), so
 * "list items by topic" is a cheap indexed query.
 *
 * `topicId` is a plain reference (not a hard FK) because deleting a taxonomy
 * entry explicitly prunes its assignments; the topic `name` is denormalized so
 * the read model renders without a join. Rows are FK children of the extraction
 * that produced them, so purging an item cascades them away.
 */
@Entity({ name: 'item_topics' })
@Index(['userId'])
@Index(['topicId'])
@Index(['inboxItemId'])
@Index(['extractionId'])
export class ItemTopicEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** Denormalized owning item, so assignments are cheap to scope and purge. */
  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** Denormalized owner for per-user scoping. */
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  topicId!: string;

  /** Topic name at assignment time — keeps the read model stable and join-free. */
  @Column({ type: 'varchar' })
  name!: string;

  /** Model confidence for this assignment (0..1). */
  @Column({ type: 'float' })
  confidence!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
