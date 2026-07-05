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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
