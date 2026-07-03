import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * An account. Authentication is passkey-only (WebAuthn); a user owns one or
 * more passkey_credentials and every piece of content (inbox items, voice
 * profiles, calendar feeds, Plaud settings, ...) is scoped to a userId —
 * users are fully isolated from each other, nothing is shared.
 *
 * The id is assigned by the auth service (not DB-generated) because the very
 * first registered user deliberately receives DEFAULT_USER_ID, adopting all
 * data created while the instance ran without authentication.
 */
@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Normalized to lowercase; uniqueness is therefore case-insensitive. */
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  username!: string;

  /**
   * The WebAuthn user handle (base64url) shared by all of this user's
   * passkeys — the spec mandates one stable handle per user per RP.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  webauthnUserId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
