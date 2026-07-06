import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  SensitivityDetection,
  SensitivitySpan,
  SensitivityTier,
} from '@plaudern/contracts';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * The sensitivity classification of one inbox item (JJ-21) — produced by the
 * `sentinel` extractor from the item's transcript. One row per item.
 *
 * User-scoped and MUTABLE (unlike the append-only inbox aggregate), so it lives
 * OUTSIDE the inbox aggregate like a reminder/decision. Two-owner columns split
 * exactly like the reminders status rule:
 *
 * - `detectedTier` / `detections` / `spans` / `llmClassified` are
 *   EXTRACTION-owned: a re-run of the sentinel overwrites them.
 * - `manualTier` is USER-owned: a user's override survives re-classification —
 *   the upsert's UPDATE path OMITS it. The EFFECTIVE tier is
 *   `manualTier ?? detectedTier`.
 *
 * `held`/`heldReason` are routing state set by the extraction pipeline when a
 * local-only item cannot run an external-LLM extractor because no local model
 * tier is configured ("held: needs local model").
 */
@Entity({ name: 'item_sensitivity' })
@Index(['userId'])
@Index(['inboxItemId'], { unique: true })
export class ItemSensitivityEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `sentinel` extraction generation that last produced the classification. */
  @Column({ type: 'uuid' })
  extractionId!: string;

  /** Extraction-owned automatic tier. */
  @Column({ type: 'varchar', default: 'normal' })
  detectedTier!: SensitivityTier;

  /** User-owned override; when set it wins over `detectedTier`. */
  @Column({ type: 'varchar', nullable: true })
  manualTier!: SensitivityTier | null;

  /** Rolled-up counts per detection category. */
  @Column({ type: 'simple-json', nullable: true })
  detections!: SensitivityDetection[] | null;

  /** Matched spans (offsets into the classified transcript) for masking. */
  @Column({ type: 'simple-json', nullable: true })
  spans!: SensitivitySpan[] | null;

  @Column({ type: 'boolean', default: false })
  llmClassified!: boolean;

  /** True while an external-LLM extraction is withheld pending a local tier. */
  @Column({ type: 'boolean', default: false })
  held!: boolean;

  @Column({ type: 'varchar', nullable: true })
  heldReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
