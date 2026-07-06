import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AiProviderProtocol } from '@plaudern/contracts';

/**
 * A per-user AI provider *connection* (credentials): a reusable endpoint the
 * user can point one or more capabilities at (e.g. a single DeepSeek key shared
 * by summarization, entities, tasks, …). Replaces the old per-capability
 * `<PREFIX>_API_KEY`/`_BASE_URL` env vars. Configuration, not captured content,
 * so — like Plaud/email settings — it lives outside the immutable inbox aggregate.
 *
 * The API key is encrypted at rest with `APP_ENCRYPTION_SECRET`
 * (`secret-crypto.ts`), never returned to the client in plaintext, and null for
 * keyless local endpoints (Ollama, llama.cpp, …).
 */
@Entity({ name: 'ai_providers' })
@Index(['userId'])
@Index(['userId', 'name'], { unique: true })
export class AiProviderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** User-chosen label, e.g. "DeepSeek" or "Local Ollama". Unique per user. */
  @Column({ type: 'varchar' })
  name!: string;

  /** Wire protocol: openai-compatible | elevenlabs | whisper | pyannoteai. */
  @Column({ type: 'varchar' })
  protocol!: AiProviderProtocol;

  @Column({ type: 'varchar' })
  baseUrl!: string;

  /** AES-256-GCM ciphertext of the API key, or null for keyless endpoints. */
  @Column({ type: 'varchar', nullable: true })
  apiKeyEncrypted!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
