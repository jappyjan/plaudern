import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { NotificationCategory, NotificationChannel } from '@plaudern/contracts';

/**
 * Append-only log of dispatched notifications — one row per `notify()` that
 * actually delivered to at least one channel. It backs the per-category
 * frequency cap (count rows in the last 24h) and gives proactive features an
 * audit trail. Test sends are recorded with status `test` so they never count
 * against a real category's cap.
 */
@Entity({ name: 'notification_deliveries' })
@Index(['userId', 'category', 'createdAt'])
export class NotificationDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  category!: NotificationCategory;

  /** Channels this dispatch was delivered on. */
  @Column({ type: 'simple-json' })
  channels!: NotificationChannel[];

  /** `sent` counts toward frequency caps; `test` and `failed` do not. */
  @Column({ type: 'varchar' })
  status!: 'sent' | 'failed' | 'test';

  @CreateDateColumn()
  createdAt!: Date;
}
