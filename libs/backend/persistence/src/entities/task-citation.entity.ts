import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InboxItemEntity } from './inbox-item.entity';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { TaskEntity } from './task.entity';

/**
 * One appearance of a task in one recording (JJ-35) — the edge that turns "ten
 * mentions of the dentist" into one task with ten citations. Keyed to the
 * `tasks` extraction row that produced it so append-only reprocessing yields a
 * fresh set of citations per extraction; the tasks service counts only the
 * latest succeeded extraction per item, exactly like entity mentions.
 *
 * The unique (extractionId, taskId) index makes ingestion idempotent: a re-run
 * or backfill of the same extraction can never double-cite a task.
 */
@Entity({ name: 'task_citations' })
@Index(['inboxItemId'])
@Index(['taskId'])
@Index(['extractionId', 'taskId'], { unique: true })
export class TaskCitationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => TaskEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'taskId' })
  task!: TaskEntity;

  @Column({ type: 'uuid' })
  taskId!: string;

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

  /** The sentence this recording mentioned the task in; null if not captured. */
  @Column({ type: 'text', nullable: true })
  quote!: string | null;

  /** Segment start (seconds) into the recording when the quote was located. */
  @Column({ type: 'float', nullable: true })
  startSeconds!: number | null;

  /** Segment end (seconds) into the recording when the quote was located. */
  @Column({ type: 'float', nullable: true })
  endSeconds!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
