import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Per-user MCP access token — the credential an MCP client (Claude or any other
 * agent) presents as a Bearer token to reach the user's memory over `/api/mcp`.
 * Exactly one row per user (mint/rotate replaces it; revoke deletes it), so a
 * user has at most one live token at a time.
 *
 * Unlike the email-in token this is NOT redisplayable: only the sha256
 * `tokenHash` (the lookup key, unique-indexed) is stored, mirroring auth
 * sessions — a leaked row cannot be replayed as a token. `tokenPrefix` is a
 * short, non-sensitive slice of the plaintext kept purely so the settings UI
 * can show which token is active without being able to reconstruct it.
 */
@Entity({ name: 'mcp_tokens' })
@Index(['userId'], { unique: true })
@Index(['tokenHash'], { unique: true })
export class McpTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** sha256 hex of the plaintext token — the Bearer-auth lookup key. */
  @Column({ type: 'varchar' })
  tokenHash!: string;

  /** First few characters of the plaintext (e.g. `mcp_ab12`), for display only. */
  @Column({ type: 'varchar' })
  tokenPrefix!: string;

  /** Last time this token authenticated a request; null until first use. */
  @Column({ type: 'varchar', nullable: true })
  lastUsedAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
