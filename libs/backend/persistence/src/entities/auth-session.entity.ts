import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

/**
 * A browser session, created after a successful passkey ceremony. The cookie
 * holds an opaque random token; only its sha256 hash is stored, so a database
 * leak does not yield usable sessions. Expiry is an ISO 8601 UTC varchar
 * (lexicographically comparable on Postgres and sqlite alike).
 */
@Entity({ name: 'auth_sessions' })
@Index(['userId'])
export class AuthSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  tokenHash!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity | null;

  @Column({ type: 'varchar' })
  expiresAt!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'varchar', nullable: true })
  lastUsedAt!: string | null;
}
