import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CalendarProviderType, CalendarSyncStatus } from '@plaudern/contracts';

/**
 * A subscribed calendar feed (ICS URL for now; providerType is the extension
 * point for OAuth providers). Mutable configuration, deliberately outside the
 * immutable inbox aggregate — same reasoning as plaud_settings.
 */
@Entity({ name: 'calendar_feeds' })
@Index(['userId', 'urlHash'], { unique: true })
export class CalendarFeedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  providerType!: CalendarProviderType;

  /**
   * The feed URL is a secret (it grants read access to the calendar).
   * AES-256-GCM ciphertext, format `v1:<ivB64>:<tagB64>:<dataB64>`.
   */
  @Column({ type: 'text' })
  urlEncrypted!: string;

  /** sha256 hex of the normalized URL — dedupe without decrypting. */
  @Column({ type: 'varchar' })
  urlHash!: string;

  /** Safe-to-display remnant (host + URL tail), used in DTOs and logs. */
  @Column({ type: 'varchar' })
  urlMasked!: string;

  @Column({ type: 'varchar', nullable: true })
  color!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * Opt-in automatic recording↔event linking. Off by default: users who want
   * a feed's events auto-matched to recordings enable it explicitly. Kept off
   * for e.g. a shared/partner calendar where automatic matching is noise.
   * Manual linking always works regardless.
   */
  @Column({ type: 'boolean', default: false })
  autoLink!: boolean;

  @Column({ type: 'varchar', nullable: true })
  lastSyncAt!: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastSyncStatus!: CalendarSyncStatus | null;

  @Column({ type: 'text', nullable: true })
  lastSyncError!: string | null;

  @Column({ type: 'int', nullable: true })
  lastSyncEventCount!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
