import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ConsentStatus, VoiceProfileStatus } from '@plaudern/contracts';

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
   * Recording-consent state (§ 201 StGB guardian). `unknown` until the user
   * records whether this person consented to being recorded.
   */
  @Column({ type: 'varchar', default: 'unknown' })
  consentStatus!: ConsentStatus;

  /**
   * When true, this speaker's diarized segments are excluded from every derived
   * read model (transcript, summary, search). The immutable source stays sealed.
   */
  @Column({ type: 'boolean', default: false })
  redacted!: boolean;

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
