import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A dead-man's-switch RELEASE (JJ-80): the audit-grade record of a switch that
 * tripped and the scoped emergency grant it produced. One row is created the
 * moment a check-in lapses (`pending`); it is the durable, revocable state the
 * release mechanism is built on. `dead_mans_switch` holds the owner's INTENT;
 * this table holds each ACTUAL firing.
 *
 * Lifecycle (`status`):
 *  - `pending`   — the switch tripped and a grace/confirmation window opened; no
 *    access is granted yet. A re-check-in before the window elapses cancels it.
 *  - `active`    — the grace window elapsed with no check-in, so the trusted
 *    contact was notified and holds a scoped read-only grant to the archive.
 *  - `cancelled` — the owner checked in (or disarmed) during the grace window,
 *    so the switch never released.
 *  - `revoked`   — the owner revoked a grant that had already gone `active`.
 *
 * Auth/consent scope: the grant is a SINGLE, read-only credential to the owner's
 * export bundle and nothing else — no write, no delete, no login. The raw token
 * is emailed to the contact ONCE and never stored; only its SHA-256 hash lives
 * here, so a DB read cannot impersonate the contact. Owner-revocable at any time.
 *
 * Privacy-relevant: wiped by JJ-42 panic-delete.
 */
@Entity({ name: 'dead_mans_switch_release' })
@Index(['userId'])
@Index(['status'])
export class DeadMansSwitchReleaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Owner whose switch tripped. Every query is scoped to this id. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** Trusted contact, snapshotted at fire time so a later edit can't retarget. */
  @Column({ type: 'varchar' })
  contactEmail!: string;

  /** pending | active | cancelled | revoked (see class doc). */
  @Column({ type: 'varchar', default: 'pending' })
  status!: 'pending' | 'active' | 'cancelled' | 'revoked';

  /**
   * SHA-256 of the emergency-access token; null until granted and again after a
   * revoke. The raw token is emailed to the contact once and never persisted.
   */
  @Column({ type: 'varchar', nullable: true })
  tokenHash!: string | null;

  /** When the check-in lapsed and the grace window opened (ISO in a varchar). */
  @Column({ type: 'varchar' })
  firedAt!: string;

  /** Access is granted only once now passes this instant (ISO in a varchar). */
  @Column({ type: 'varchar' })
  graceUntil!: string;

  /** When the contact was actually granted access (ISO; null while pending). */
  @Column({ type: 'varchar', nullable: true })
  grantedAt!: string | null;

  /** When the owner revoked or the switch cancelled the release (ISO; nullable). */
  @Column({ type: 'varchar', nullable: true })
  closedAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
