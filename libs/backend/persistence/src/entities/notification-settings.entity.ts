import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user notification engine settings — one mutable row per user. Holds the
 * cross-cutting knobs (timezone, quiet-hours window, email delivery address);
 * per-category opt-in lives in `notification_category_preferences`. Like the
 * other settings tables this is configuration, so it sits outside the
 * immutable inbox aggregate.
 */
@Entity({ name: 'notification_settings' })
@Index(['userId'], { unique: true })
export class NotificationSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** IANA timezone quiet hours are evaluated in (e.g. `Europe/Berlin`). */
  @Column({ type: 'varchar', default: 'UTC' })
  timezone!: string;

  /** Delivery address for the email channel; null until the user sets one. */
  @Column({ type: 'varchar', nullable: true })
  emailAddress!: string | null;

  @Column({ type: 'boolean', default: true })
  quietHoursEnabled!: boolean;

  /** `HH:MM` local start of the quiet window. */
  @Column({ type: 'varchar', default: '22:00' })
  quietHoursStart!: string;

  /** `HH:MM` local end of the quiet window (may be before start = overnight). */
  @Column({ type: 'varchar', default: '07:00' })
  quietHoursEnd!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
