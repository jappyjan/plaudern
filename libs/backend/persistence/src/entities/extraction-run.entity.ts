import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  ExtractionKind,
  ExtractionRunStatus,
  ExtractionRunTrigger,
} from '@plaudern/contracts';

/**
 * A backfill run: "re-run `kind@version` over past items" (VISION §8). The run
 * row is bookkeeping only — the actual work is ordinary append-only extraction
 * rows enqueued through the extractor's normal path, so the immutability
 * guarantee is untouched. Scoped to the requesting user like all inbox data.
 */
@Entity({ name: 'extraction_runs' })
@Index(['userId', 'createdAt'])
export class ExtractionRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Owner of a user-triggered run. NULL for `trigger: 'startup'` sweeps, which
   * are system-wide (they scan every user's items on API boot).
   */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar' })
  kind!: ExtractionKind;

  /** How this run was started: an explicit request, or the automatic boot sweep. */
  @Column({ type: 'varchar', default: 'manual' })
  trigger!: ExtractionRunTrigger;

  /** Extractor version this run targets (the registered version at start time). */
  @Column({ type: 'int' })
  targetVersion!: number;

  /** Re-run even items already at the target version. */
  @Column({ type: 'boolean', default: false })
  force!: boolean;

  /** Optional occurredAt window (ISO instants) limiting which items are visited. */
  @Column({ type: 'varchar', nullable: true })
  occurredFrom!: string | null;

  @Column({ type: 'varchar', nullable: true })
  occurredTo!: string | null;

  @Column({ type: 'varchar', default: 'running' })
  status!: ExtractionRunStatus;

  @Column({ type: 'int', default: 0 })
  itemsMatched!: number;

  @Column({ type: 'int', default: 0 })
  itemsQueued!: number;

  @Column({ type: 'int', default: 0 })
  itemsSkipped!: number;

  @Column({ type: 'int', default: 0 })
  itemsFailed!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  /**
   * Touched by TypeORM on every save/update — the per-batch counter update in
   * the run loop doubles as a liveness heartbeat. A `running` startup run whose
   * updatedAt is old is treated as stale (its process died mid-sweep) and is
   * superseded on the next boot instead of wedging the kind forever.
   */
  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'varchar', nullable: true })
  completedAt!: string | null;
}
