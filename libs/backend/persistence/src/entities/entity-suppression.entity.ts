import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EntityType } from '@plaudern/contracts';

/**
 * A normalized name the user deleted/suppressed (JJ-63) that must NOT be
 * recreated by future extraction runs. The registry upsert path consults this
 * and skips both the entity and its mention when a (type, normalizedName) is
 * suppressed — so a bogus or unwanted entity stays gone across backfills.
 *
 * Keyed (userId, type, normalizedName), matching the `entities` dedupe key.
 * No FK: the suppressed entity row is hard-deleted, so this outlives it.
 */
@Entity({ name: 'entity_suppressions' })
@Index(['userId', 'type', 'normalizedName'], { unique: true })
export class EntitySuppressionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  type!: EntityType;

  /** Lowercased, whitespace-collapsed name that must not be recreated. */
  @Column({ type: 'varchar' })
  normalizedName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
