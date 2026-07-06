import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AiCapabilityKind } from '@plaudern/contracts';

/**
 * A per-user *shared* AI setting for one capability kind (chat, vision,
 * embeddings, stt, diarization). This is the simplified, kind-level knob the
 * settings UI exposes: one provider connection + model + params that powers
 * every capability of that kind unless a per-task override
 * (`ai_capability_settings`) says otherwise.
 *
 * At most one row per (user, kind). A missing row, a null `providerId`, or
 * `enabled=false` mean the whole group is off for that user (every member
 * capability no-ops), unless a member carries its own override.
 */
@Entity({ name: 'ai_capability_group_settings' })
@Index(['userId'])
@Index(['userId', 'kind'], { unique: true })
export class AiCapabilityGroupSettingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Capability kind: chat | vision | embeddings | stt | diarization. */
  @Column({ type: 'varchar' })
  kind!: AiCapabilityKind;

  /** Chosen provider connection; null = unconfigured (group disabled). */
  @Column({ type: 'uuid', nullable: true })
  providerId!: string | null;

  /** Shared model override; null falls back to the group's registry default. */
  @Column({ type: 'varchar', nullable: true })
  model!: string | null;

  /** Shared request timeout override (ms); null falls back to the default. */
  @Column({ type: 'int', nullable: true })
  timeoutMs!: number | null;

  /** User toggle to disable the whole group without unassigning the provider. */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** Shared capability params (dimensions, thresholds, tagAudioEvents, …). */
  @Column({ type: 'simple-json', nullable: true })
  params!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
