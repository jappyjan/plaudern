import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Legacy / emergency-access ("dead-man's switch") config (JJ-42) — one row per
 * user. A life archive needs an answer for incapacity: a trusted contact and a
 * check-in interval so that, if the owner stops checking in, someone can be
 * reached.
 *
 * MINIMAL scaffold: this table + the check-in ritual persist the intent; the
 * actual release mechanism (notifying the contact / granting access when a
 * check-in lapses) is deferred to a follow-up. Nothing fires off this row yet.
 */
@Entity({ name: 'dead_mans_switch' })
@Index(['userId'], { unique: true })
export class DeadMansSwitchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  /** Trusted contact reached on incapacity; null until configured. */
  @Column({ type: 'varchar', nullable: true })
  contactEmail!: string | null;

  /** Days without a check-in before the switch is considered tripped. */
  @Column({ type: 'integer', default: 90 })
  checkInIntervalDays!: number;

  /**
   * Last time the owner proved they are around (ISO 8601 in a varchar, the
   * cross-driver convention used across the app); null until first check-in.
   */
  @Column({ type: 'varchar', nullable: true })
  lastCheckInAt!: string | null;

  /**
   * JJ-80 review follow-up (F1): when the owner revokes a release, this is set
   * to the `lastCheckInAt` value in effect at revoke time — a marker for "the
   * CURRENT lapse is disarmed". A sweep skips arming a new release while this
   * still equals `lastCheckInAt` (no fresh check-in yet). The next real
   * check-in changes `lastCheckInAt` (and clears this field), so the marker
   * goes stale and a later lapse arms normally again. Null means "not
   * suppressed" (the common case).
   */
  @Column({ type: 'varchar', nullable: true })
  armingSuspendedForCheckInAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
