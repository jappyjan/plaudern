import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { ChatCitation, ChatConfidence, ChatRole } from '@plaudern/contracts';
import { ChatConversationEntity } from './chat-conversation.entity';

/** Citations round-trip as JSON text so the sqlite test DB needs no JSONB. */
const citationsTransformer = {
  to: (value: ChatCitation[]): string => JSON.stringify(value ?? []),
  from: (value: string | ChatCitation[] | null): ChatCitation[] => {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as ChatCitation[]) : [];
    } catch {
      return [];
    }
  },
};

/**
 * One turn of a memory-chat conversation (JJ-37). Assistant rows persist the
 * enforced citations (inbox item + optional transcript timestamp) alongside
 * the answer text, so a conversation replays with its evidence intact even as
 * new extractions land — the citations are a snapshot of what the answer was
 * actually based on.
 */
@Entity({ name: 'chat_messages' })
@Index(['userId'])
@Index(['conversationId', 'createdAt'])
export class ChatMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne(() => ChatConversationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation?: ChatConversationEntity;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  role!: ChatRole;

  /** Message text; assistant answers carry inline `[n]` citation markers. */
  @Column({ type: 'text' })
  content!: string;

  /** The enforced citations backing an assistant answer (empty for users). */
  @Column({ type: 'text', transformer: citationsTransformer })
  citations!: ChatCitation[];

  /** Server-enforced confidence ('high' | 'low'); null for user messages. */
  @Column({ type: 'varchar', nullable: true })
  confidence!: ChatConfidence | null;

  @CreateDateColumn()
  createdAt!: Date;
}
