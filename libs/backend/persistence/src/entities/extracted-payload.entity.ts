import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ExtractionKind, ExtractionSegment, ExtractionStatus } from '@plaudern/contracts';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * An append-only derived artifact (transcription/OCR/...). Reprocessing inserts
 * a NEW row rather than mutating an existing one, preserving the audit trail
 * and the immutability guarantee (plan §2/§5).
 */
@Entity({ name: 'extracted_payloads' })
@Index(['inboxItemId', 'kind'])
export class ExtractedPayloadEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => InboxItemEntity, (item) => item.extractions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  @Column({ type: 'varchar' })
  kind!: ExtractionKind;

  /**
   * Version of the extractor (kind@version) that produced this row. Bumped by
   * an extractor when its output meaningfully improves; backfill runs use it
   * to find items still on an older version.
   */
  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'varchar' })
  provider!: string;

  @Column({ type: 'varchar', default: 'queued' })
  status!: ExtractionStatus;

  @Column({ type: 'text', nullable: true })
  content!: string | null;

  /** For large/rich outputs stored as an object instead of inline text. */
  @Column({ type: 'varchar', nullable: true })
  contentStorageKey!: string | null;

  /** Timed segments: transcription => {start,end,text}, diarization => {start,end,speaker}. */
  @Column({ type: 'simple-json', nullable: true })
  segments!: ExtractionSegment[] | null;

  @Column({ type: 'varchar', nullable: true })
  language!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'varchar', nullable: true })
  completedAt!: string | null;
}
