import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AiCapability } from '@plaudern/contracts';

/**
 * Per-user assignment of one AI capability (summarization, ocr, transcription,
 * …) to a provider connection (`ai_providers`), plus its model/params. Replaces
 * the old per-capability `<PREFIX>_MODEL`/`_TIMEOUT_MS`/`_ENABLED` env vars. At
 * most one row per (user, capability). Missing values inherit from the shared
 * capability group; `enabled=false` is the explicit per-capability off switch.
 */
@Entity({ name: 'ai_capability_settings' })
@Index(['userId'])
@Index(['userId', 'capability'], { unique: true })
export class AiCapabilitySettingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  capability!: AiCapability;

  /** Chosen provider connection; null inherits the shared group provider. */
  @Column({ type: 'uuid', nullable: true })
  providerId!: string | null;

  /** Model override; null inherits the group or registry default. */
  @Column({ type: 'varchar', nullable: true })
  model!: string | null;

  /** Request timeout override (ms); null falls back to the default. */
  @Column({ type: 'int', nullable: true })
  timeoutMs!: number | null;

  /** User toggle to disable without unassigning the provider. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Capability-specific params (dimensions, thresholds, tagAudioEvents, …). */
  @Column({ type: 'simple-json', nullable: true })
  params!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
