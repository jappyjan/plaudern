import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { EntityType, MergeSuggestionSource, MergeSuggestionStatus } from '@plaudern/contracts';

/**
 * A detected likely-duplicate PAIR the user may want to merge (JJ-63). Written
 * by the reconciliation service — automatically after extraction (cheap exact
 * cross-type detection) or on demand — and surfaced so the user can confirm the
 * merge. This table only ever RECORDS a suggestion; merges themselves stay
 * user-confirmed and go through the transactional correction path, so a bad
 * suggestion never destroys data.
 *
 * The pair is stored canonicalized (`entityId` = the smaller id, then
 * `candidateEntityId`) with a unique key over both, so A↔B and B↔A collapse to
 * one row and the same pair isn't suggested twice. Both id columns reference
 * `entities` ON DELETE CASCADE: once a merge deletes the victim, its suggestions
 * disappear with it.
 */
@Entity({ name: 'entity_merge_suggestions' })
@Index(['userId', 'status'])
@Index(['userId', 'entityId', 'candidateEntityId'], { unique: true })
export class EntityMergeSuggestionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Canonicalized smaller of the two entity ids in the pair. */
  @Column({ type: 'uuid' })
  entityId!: string;

  /** Canonicalized larger of the two entity ids in the pair. */
  @Column({ type: 'uuid' })
  candidateEntityId!: string;

  /** Which side the judge recommends keeping; null until judged. */
  @Column({ type: 'uuid', nullable: true })
  recommendedSurvivorId!: string | null;

  /** The type the judge recommends for the survivor; null until judged. */
  @Column({ type: 'varchar', nullable: true })
  recommendedType!: EntityType | null;

  /** Whether the judge decided the two are the same real-world thing. */
  @Column({ type: 'boolean', nullable: true })
  sameThing!: boolean | null;

  /** Judge confidence in [0,1]; null until judged. */
  @Column({ type: 'float', nullable: true })
  confidence!: number | null;

  /** Short human-readable justification from the judge; null until judged. */
  @Column({ type: 'text', nullable: true })
  rationale!: string | null;

  /** True when web research contributed to the recommendation. */
  @Column({ type: 'boolean', default: false })
  usedWeb!: boolean;

  /** How the suggestion arose: automatic detection vs a manual reconcile call. */
  @Column({ type: 'varchar' })
  source!: MergeSuggestionSource;

  /** Lifecycle: pending until the user merges (applied) or dismisses it. */
  @Column({ type: 'varchar', default: 'pending' })
  status!: MergeSuggestionStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
