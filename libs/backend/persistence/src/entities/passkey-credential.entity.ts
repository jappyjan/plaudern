import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

/**
 * A registered WebAuthn passkey. A user can hold several (phone, laptop,
 * hardware key); the last one cannot be removed since passkeys are the only
 * way to sign in.
 */
@Entity({ name: 'passkey_credentials' })
@Index(['userId'])
export class PasskeyCredentialEntity {
  /** WebAuthn credential id (base64url) — globally unique by construction. */
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity | null;

  /** COSE public key, base64url encoded. */
  @Column({ type: 'text' })
  publicKey!: string;

  /** Signature counter for clone detection (0 for most platform passkeys). */
  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number | null) => (value === null ? 0 : Number(value)),
    },
  })
  counter!: number;

  /** Authenticator transports hint, e.g. ["internal","hybrid"]. */
  @Column({ type: 'simple-json', nullable: true })
  transports!: string[] | null;

  /** 'singleDevice' | 'multiDevice' (synced passkey). */
  @Column({ type: 'varchar' })
  deviceType!: string;

  @Column({ type: 'boolean', default: false })
  backedUp!: boolean;

  /** User-facing name, defaulted from registration context. */
  @Column({ type: 'varchar', nullable: true })
  label!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'varchar', nullable: true })
  lastUsedAt!: string | null;
}
