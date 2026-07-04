import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A registered Web Push (VAPID) subscription — one per browser/device. Scoped
 * to its owner; the endpoint is globally unique (the push service's URL), so a
 * device that re-subscribes upserts its existing row.
 */
@Entity({ name: 'push_subscriptions' })
@Index(['userId'])
@Index(['endpoint'], { unique: true })
export class PushSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  /** Client public key (base64url) used to encrypt the push payload. */
  @Column({ type: 'text' })
  p256dh!: string;

  /** Client auth secret (base64url) used to encrypt the push payload. */
  @Column({ type: 'text' })
  auth!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
