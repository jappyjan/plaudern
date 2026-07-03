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
   * ICS feed URL (secret). AES-256-GCM ciphertext `v1:<iv>:<tag>:<data>`.
   * Null for non-ICS providers (google).
   */
  @Column({ type: 'text', nullable: true })
  urlEncrypted!: string | null;

  /** sha256 hex of the normalized URL — dedupe without decrypting. Null for google. */
  @Column({ type: 'varchar', nullable: true })
  urlHash!: string | null;

  /** Safe-to-display remnant. For google feeds, a readable "email · calendar" label. */
  @Column({ type: 'varchar', nullable: true })
  urlMasked!: string | null;

  /** Google calendar id (e.g. 'primary' or '…@group.calendar.google.com'). Null for ics. */
  @Column({ type: 'varchar', nullable: true })
  googleCalendarId!: string | null;

  /** Owning Google account email — groups feeds for reconnect + dedup. Null for ics. */
  @Column({ type: 'varchar', nullable: true })
  googleAccountEmail!: string | null;

  /** OAuth refresh token (secret), AES-256-GCM encrypted like urlEncrypted. Null for ics. */
  @Column({ type: 'text', nullable: true })
  googleRefreshTokenEncrypted!: string | null;

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
