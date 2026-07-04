import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';
import { VoiceProfileEntity } from './voice-profile.entity';

/**
 * One diarized speaker in one recording, linked to a voice profile. Keyed to
 * the diarization extraction row that produced it so append-only reprocessing
 * yields a fresh set of occurrences per extraction.
 */
@Entity({ name: 'speaker_occurrences' })
@Index(['inboxItemId'])
@Index(['voiceProfileId'])
@Index(['extractionId', 'label'], { unique: true })
export class SpeakerOccurrenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  @ManyToOne(() => VoiceProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'voiceProfileId' })
  voiceProfile!: VoiceProfileEntity;

  @Column({ type: 'uuid' })
  voiceProfileId!: string;

  /** Per-recording diarization label, e.g. SPEAKER_00. */
  @Column({ type: 'varchar' })
  label!: string;

  @Column({ type: 'float', default: 0 })
  speakingSeconds!: number;

  /** 1 when /identify matched an existing profile; null when this occurrence created the profile. */
  @Column({ type: 'float', nullable: true })
  similarity!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
