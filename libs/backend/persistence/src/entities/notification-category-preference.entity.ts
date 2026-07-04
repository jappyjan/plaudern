import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { NotificationCategory, NotificationChannel } from '@plaudern/contracts';

/**
 * Per-user, per-category notification preference: which channels are opted in
 * and the daily frequency cap. One row per (user, category); absent rows fall
 * back to `DEFAULT_CATEGORY_PREFERENCES`.
 */
@Entity({ name: 'notification_category_preferences' })
@Index(['userId', 'category'], { unique: true })
export class NotificationCategoryPreferenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  category!: NotificationCategory;

  /** Channels opted into for this category. Empty array = category muted. */
  @Column({ type: 'simple-json' })
  channels!: NotificationChannel[];

  /** Max deliveries per rolling 24h; null = unlimited. */
  @Column({ type: 'integer', nullable: true })
  maxPerDay!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
