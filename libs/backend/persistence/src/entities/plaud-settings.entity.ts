import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { PlaudRegion, PlaudSyncStatus } from '@plaudern/contracts';

/**
 * Plaud cloud sync configuration — one mutable row per user (singleton in the
 * single-user setup). Deliberately NOT part of the immutable inbox aggregate:
 * settings are configuration, not captured content.
 */
@Entity({ name: 'plaud_settings' })
@Index(['userId'], { unique: true })
export class PlaudSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  email!: string;

  /** AES-256-GCM ciphertext, format `v1:<ivB64>:<tagB64>:<dataB64>`. */
  @Column({ type: 'text' })
  passwordEncrypted!: string;

  @Column({ type: 'varchar' })
  region!: PlaudRegion;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** Cached Plaud JWT (survives restarts; Plaud tokens last ~300 days). */
  @Column({ type: 'text', nullable: true })
  accessToken!: string | null;

  /** ISO 8601 expiry derived from the JWT `exp` claim. */
  @Column({ type: 'varchar', nullable: true })
  accessTokenExpiresAt!: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastSyncAt!: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastSyncStatus!: PlaudSyncStatus | null;

  @Column({ type: 'text', nullable: true })
  lastSyncError!: string | null;

  @Column({ type: 'int', nullable: true })
  lastSyncImportedCount!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
