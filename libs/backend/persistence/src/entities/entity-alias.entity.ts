import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EntityType } from '@plaudern/contracts';

/**
 * A normalized name that must resolve to a specific surviving registry entity
 * (JJ-63). Written when entities are merged (the victim's names point at the
 * survivor) or renamed (the old normalized name points at the entity), so the
 * next extraction/backfill that sees the name upserts onto the surviving entity
 * instead of resurrecting a merged-away duplicate.
 *
 * Keyed (userId, type, normalizedName) — the same shape as the `entities`
 * dedupe key — so alias resolution is type-scoped. A loose `entityId`
 * reference with ON DELETE CASCADE: deleting the surviving entity drops its
 * alias rows too.
 */
@Entity({ name: 'entity_aliases' })
@Index(['entityId'])
@Index(['userId', 'type', 'normalizedName'], { unique: true })
export class EntityAliasEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** The surviving entity this normalized name resolves to. */
  @Column({ type: 'uuid' })
  entityId!: string;

  @Column({ type: 'varchar' })
  type!: EntityType;

  /** Lowercased, whitespace-collapsed name that resolves to `entityId`. */
  @Column({ type: 'varchar' })
  normalizedName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
