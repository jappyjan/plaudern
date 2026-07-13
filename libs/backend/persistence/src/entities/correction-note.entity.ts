import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * A user correction note on one inbox item — free text that gets fed into
 * summary (re)generation as an authoritative correction ("the transcript says
 * 'Maier' but the name is 'Meier'").
 *
 * Lives OUTSIDE the append-only inbox aggregate (like item_sensitivity):
 * notes are user-owned input, not derived data, so they may be added and
 * deleted freely — the source blob and its extraction rows are never touched.
 * Multiple notes per item, applied together on the next generation.
 */
@Entity({ name: 'correction_notes' })
@Index(['userId'])
@Index(['inboxItemId'])
export class CorrectionNoteEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The correction/remark itself, as entered by the user. */
  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
