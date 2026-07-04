import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user consent-guardian policy (§ 201 StGB) — one mutable row per user.
 * Configuration, not captured content, so it lives outside the immutable inbox
 * aggregate like the other settings tables.
 */
@Entity({ name: 'consent_settings' })
@Index(['userId'], { unique: true })
export class ConsentSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * When true, a recording is deleted whole as soon as diarization detects a
   * voice whose consent is `declined`.
   */
  @Column({ type: 'boolean', default: false })
  autoDeleteDeclined!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
