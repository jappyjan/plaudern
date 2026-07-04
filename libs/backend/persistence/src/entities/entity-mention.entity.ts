import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EntityRegistryEntity } from './entity-registry.entity';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One appearance of a registry entity in one recording (JJ-32) — the edge of
 * the knowledge graph. Keyed to the `entities` extraction row that produced it
 * so append-only reprocessing yields a fresh set of mentions per extraction;
 * the registry service counts only the latest succeeded extraction per item.
 */
@Entity({ name: 'entity_mentions' })
@Index(['inboxItemId'])
@Index(['entityId'])
@Index(['extractionId', 'entityId'], { unique: true })
export class EntityMentionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => EntityRegistryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: EntityRegistryEntity;

  @Column({ type: 'uuid' })
  entityId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** Denormalized owner for per-user scoping and purge. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** The surface form as it appeared in this recording. */
  @Column({ type: 'varchar' })
  surfaceForm!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
