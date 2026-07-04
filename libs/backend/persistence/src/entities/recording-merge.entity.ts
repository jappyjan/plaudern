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

/**
 * One source recording inside a merged recording. The merged item is a
 * regular (immutable) inbox item with the concatenated audio; the sources are
 * never modified — these link rows only hide them from the inbox list, which
 * is what makes splitting a merge lossless: delete the merged item and its
 * links, and the untouched sources reappear.
 *
 * `sourceItemId` is unique (a recording can be part of at most one merge) and
 * deliberately does NOT cascade from the source item, so a hidden source
 * cannot be deleted out from under its merge.
 */
@Entity({ name: 'recording_merges' })
@Index(['userId'])
@Index(['sourceItemId'], { unique: true })
@Index(['mergedItemId', 'position'], { unique: true })
export class RecordingMergeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, (item) => item.mergeSources, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'mergedItemId' })
  mergedItem!: InboxItemEntity | null;

  @Column({ type: 'uuid' })
  mergedItemId!: string;

  @ManyToOne(() => InboxItemEntity)
  @JoinColumn({ name: 'sourceItemId' })
  sourceItem!: InboxItemEntity | null;

  @Column({ type: 'uuid' })
  sourceItemId!: string;

  /** 0-based playback order in the merged audio (chronological by occurredAt). */
  @Column({ type: 'int' })
  position!: number;

  /** Seconds this source contributes; offset(i) = Σ durations of positions 0..i-1. */
  @Column({ type: 'float', default: 0 })
  sourceDurationSeconds!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
