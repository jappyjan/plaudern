import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ExtractionKind, ExtractionRunStatus } from '@plaudern/contracts';

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

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  kind!: ExtractionKind;

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

  @Column({ type: 'varchar', nullable: true })
  completedAt!: string | null;
}
