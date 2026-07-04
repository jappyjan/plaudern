import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { SummaryLanguagePreference } from '@plaudern/contracts';

/**
 * Per-user AI summarization preferences — one mutable row per user. Like Plaud
 * settings, this is configuration (not captured content), so it lives outside
 * the immutable inbox aggregate.
 */
@Entity({ name: 'summarization_settings' })
@Index(['userId'], { unique: true })
export class SummarizationSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Preferred summary output language; `auto` follows the recording. */
  @Column({ type: 'varchar', default: 'auto' })
  language!: SummaryLanguagePreference;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
