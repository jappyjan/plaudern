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
 * A persistent "person" derived from a voice. Auto-created as `unconfirmed` the
 * first time a voice is heard; confirmed/named/merged by the user in the contact
 * book. Mutable by design, so it lives outside the immutable inbox aggregate.
 *
 * Cross-recording identity is carried by the `voiceprint`, matched server-side
 * via pyannoteAI's /identify endpoint.
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

  /**
   * Opaque pyannoteAI voiceprint used for server-side /identify matching.
   * Null when the speaker was too brief to enroll (profile exists but is not
   * auto-matchable).
   */
  @Column({ type: 'text', nullable: true })
  voiceprint!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
