import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { VoiceProfileStatus } from '@plaudern/contracts';

/**
 * A persistent "person" derived from voice embeddings. Auto-created as
 * `unconfirmed` the first time a voice is heard; confirmed/named/merged by the
 * user in the contact book. Mutable by design, so it lives outside the
 * immutable inbox aggregate.
 */
@Entity({ name: 'voice_profiles' })
@Index(['userId'])
export class VoiceProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', default: 'unconfirmed' })
  status!: VoiceProfileStatus;

  /** L2-normalized centroid of all embeddings matched to this profile. */
  @Column({ type: 'simple-json' })
  centroid!: number[];

  @Column({ type: 'int', default: 1 })
  embeddingCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
