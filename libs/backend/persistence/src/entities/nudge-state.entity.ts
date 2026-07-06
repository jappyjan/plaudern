import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CommitmentEntity } from './commitment.entity';

/**
 * Per-commitment nudge state (JJ-26). Nudges themselves are DERIVED on every
 * read (from the open commitments + their due/age + a deterministic resolution
 * check against later recordings), so this table stores ONLY the state the
 * derived view can't recompute: whether a proactive notification already fired,
 * and the user's dismiss / snooze decisions.
 *
 * Ownership split (mirrors the reminders rule):
 *  - `nudgedAt` is SYSTEM-owned — the scheduler sets it once so a nudge's
 *    notification fires exactly once (until a snooze elapses, which clears it).
 *  - `dismissed` and `snoozedUntil` are USER-owned — they must survive
 *    re-extraction of the underlying commitment, so the sweep's upsert only ever
 *    writes `nudgedAt` and NEVER touches these fields on the update path.
 *
 * The row is keyed by (userId, commitmentId) and its `commitmentId` FK cascades
 * with the commitment: because the `commitments` upsert preserves a row's id
 * across re-extraction, this state rides along unchanged; only if the commitment
 * is genuinely reaped (no longer produced AND still open) does the cascade drop
 * the now-moot state — so extraction-owned churn is reaped, user intent is not.
 */
@Entity({ name: 'nudge_state' })
@Index(['userId'])
@Index(['userId', 'commitmentId'], { unique: true })
export class NudgeStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => CommitmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'commitmentId' })
  commitment!: CommitmentEntity;

  @Column({ type: 'uuid' })
  commitmentId!: string;

  /**
   * When the proactive notification last fired (ISO in a varchar; null = never).
   * SYSTEM-owned: the sweep sets it so a nudge fires once; a fresh snooze clears
   * it so the notification re-arms after the snooze window.
   */
  @Column({ type: 'varchar', nullable: true })
  nudgedAt!: string | null;

  /** USER-owned: permanently hide this nudge. Never reset by the sweep. */
  @Column({ type: 'boolean', default: false })
  dismissed!: boolean;

  /**
   * USER-owned: suppress the nudge until this instant (ISO in a varchar; null =
   * not snoozed). Once it passes, the nudge is eligible again and its
   * notification re-fires.
   */
  @Column({ type: 'varchar', nullable: true })
  snoozedUntil!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
