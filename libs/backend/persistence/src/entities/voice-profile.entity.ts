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
 * Cross-recording identity is carried by exactly one of two mechanisms,
 * depending on which provider created the profile (SPEAKER_ID_PROVIDER):
 *   - `pyannote` (local sidecar): a `centroid` embedding matched by cosine.
 *   - `pyannoteai` (hosted API): an opaque `voiceprint` matched server-side via
 *     the /identify endpoint. Embeddings are not exposed by that API.
 * The unused column is null; the two provider paths never share profiles (their
 * matchers ignore profiles that lack their own mechanism).
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
   * L2-normalized centroid of all embeddings matched to this profile.
   * Null for profiles created by the pyannoteAI (voiceprint) path.
   */
  @Column({ type: 'simple-json', nullable: true })
  centroid!: number[] | null;

  @Column({ type: 'int', default: 1 })
  embeddingCount!: number;

  /**
   * Opaque pyannoteAI voiceprint used for server-side /identify matching.
   * Null for profiles created by the embedding (sidecar) path.
   */
  @Column({ type: 'text', nullable: true })
  voiceprint!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
