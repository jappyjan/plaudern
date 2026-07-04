import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Email-in configuration — one mutable row per user (plan §2, `sources/email`):
 * every user gets a personal `inbox+<token>@<domain>` address. Deliberately NOT
 * part of the immutable inbox aggregate: this is configuration, not captured
 * content (mirrors PlaudSettingsEntity).
 *
 * The token is stored two ways for two different needs: `tokenEncrypted`
 * (AES-256-GCM, reversible) lets the settings UI redisplay the full address at
 * any time — unlike the Plaud password this token is not write-only, the whole
 * point is a stable address the user can see and copy. `tokenHash` (SHA-256,
 * unique-indexed) is what the inbound webhook looks up by, so resolving the
 * owning user never requires decrypting every row.
 */
@Entity({ name: 'email_settings' })
@Index(['userId'], { unique: true })
@Index(['tokenHash'], { unique: true })
export class EmailSettingsEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** AES-256-GCM ciphertext, format `v1:<ivB64>:<tagB64>:<dataB64>`. */
  @Column({ type: 'text' })
  tokenEncrypted!: string;

  /** sha256 hex of the plaintext token — the webhook's lookup key. */
  @Column({ type: 'varchar' })
  tokenHash!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
