import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AiProviderCallDirection } from '@plaudern/contracts';

/**
 * One audited call to an external AI provider (JJ-42). Written at the provider
 * adapter for calls that leave the box — transcription (ElevenLabs + self-hosted
 * Whisper), pyannoteAI diarization, the OpenAI-compatible LLM
 * extractors/generators, and the embeddings provider — so a user can see what
 * was sent, when, and to whom. (See the audit contract for the precise list of
 * wired vs. deferred call sites.)
 *
 * Privacy by design: the row stores METADATA + SIZE + a SHA-256 CONTENT HASH,
 * never the payload itself, so the audit log cannot become a second, unguarded
 * copy of the user's private data. `payloadRedacted` is populated ONLY when the
 * operator opts in (`AI_AUDIT_STORE_PAYLOAD=true`) and even then holds a
 * TRUNCATED (not PII-scrubbed) copy; binary payloads are stored as a size
 * placeholder rather than mangled text. Append-only and user-scoped; purged
 * with the user on panic-delete.
 */
@Entity({ name: 'ai_provider_calls' })
@Index(['userId', 'createdAt'])
@Index(['userId', 'kind'])
@Index(['inboxItemId'])
export class AiProviderCallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** The item the call was made for; null for non-item-scoped calls. */
  @Column({ type: 'uuid', nullable: true })
  inboxItemId!: string | null;

  /** Extraction/generation kind that drove the call (e.g. `summary`). */
  @Column({ type: 'varchar' })
  kind!: string;

  /** Provider id (e.g. `elevenlabs-scribe`, `pyannoteai`, `openai:deepseek-chat`). */
  @Column({ type: 'varchar' })
  provider!: string;

  /** Remote endpoint the bytes were sent to (host + path, no query/secrets). */
  @Column({ type: 'varchar' })
  endpoint!: string;

  @Column({ type: 'varchar', default: 'outbound' })
  direction!: AiProviderCallDirection;

  @Column({ type: 'bigint' })
  bytesSent!: number;

  /** SHA-256 (hex) of the payload sent. */
  @Column({ type: 'varchar' })
  contentHash!: string;

  /**
   * Truncated, redacted copy of the payload — stored ONLY under the operator
   * opt-in. Null by default (metadata-only auditing).
   */
  @Column({ type: 'text', nullable: true })
  payloadRedacted!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
