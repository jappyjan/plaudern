import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { RelationOrigin, RelationType } from '@plaudern/contracts';
import { EntityRegistryEntity } from './entity-registry.entity';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * One piece of evidence for a typed edge between two registry entities
 * (JJ-22) — the knowledge graph proper. Keyed to the `relations` extraction
 * row that produced it, mirroring `entity_mentions`: append-only reprocessing
 * yields a fresh evidence set per extraction, and the graph read model only
 * counts each item's latest succeeded `relations` extraction. Repeated
 * evidence of one edge across recordings stays one row per extraction and is
 * aggregated into a single edge (with an evidence count) at read time.
 */
@Entity({ name: 'entity_relations' })
@Index(['userId'])
@Index(['inboxItemId'])
@Index(['sourceEntityId'])
@Index(['targetEntityId'])
@Index(['extractionId', 'sourceEntityId', 'targetEntityId', 'relationType'], { unique: true })
export class EntityRelationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => EntityRegistryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceEntityId' })
  sourceEntity!: EntityRegistryEntity;

  @Column({ type: 'uuid' })
  sourceEntityId!: string;

  @ManyToOne(() => EntityRegistryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'targetEntityId' })
  targetEntity!: EntityRegistryEntity;

  @Column({ type: 'uuid' })
  targetEntityId!: string;

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

  @Column({ type: 'varchar' })
  relationType!: RelationType;

  /** Short free-text qualifier from the transcript ("monthly rent", …). */
  @Column({ type: 'varchar', nullable: true })
  label!: string | null;

  /** Model-reported confidence in [0, 1]; fixed low for co-occurrence edges. */
  @Column({ type: 'float', nullable: true })
  confidence!: number | null;

  /** Whether the LLM stated this edge or it is implicit co-occurrence. */
  @Column({ type: 'varchar' })
  origin!: RelationOrigin;

  @CreateDateColumn()
  createdAt!: Date;
}
