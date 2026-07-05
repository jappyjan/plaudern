import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One memory-chat conversation (JJ-37). A derived read model, never a source
 * of truth: it stores what the user asked and what the assistant answered
 * (with citations), but everything cited lives in the immutable inbox.
 * Deleting a conversation deletes its messages (cascade) and nothing else.
 */
@Entity({ name: 'chat_conversations' })
// Composite: the only list query is "this user's conversations, most recently
// active first" (ORDER BY updatedAt DESC), which this index serves directly.
@Index(['userId', 'updatedAt'])
export class ChatConversationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Auto-titled from the first question; null until one is asked. */
  @Column({ type: 'varchar', nullable: true })
  title!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
