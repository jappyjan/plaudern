import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '@plaudern/storage';
import { SpeakerOccurrenceEntity, VoiceProfileEntity } from '@plaudern/persistence';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { postJsonToSidecar } from './providers/sidecar-http';
import type { SpeakerIdentificationJob } from './speaker-identifier';

/** One diarized speaker after canonical relabeling, ready to persist. */
export interface DiarizedSpeakerLite {
  /** Canonical per-recording label, e.g. SPEAKER_00. */
  label: string;
  speakingSeconds: number;
  /** Timed ranges this speaker spoke, for voiceprint enrollment clips. */
  segments: { start: number; end: number }[];
  /** Non-null when /identify matched this speaker to an existing profile. */
  matchedProfile: VoiceProfileEntity | null;
}

interface SidecarClip {
  label: string;
  audio_base64: string;
}

/**
 * Persists pyannoteAI diarization/identification results, mirroring
 * ProfileMatcher's role for the embedding path but built on voiceprints:
 *
 *  - matched speakers link to their existing profile;
 *  - each new speaker with enough clean speech is auto-enrolled — its longest
 *    segments are sliced by the sidecar's ffmpeg (`/voiceprint-clips`),
 *    uploaded, and turned into a pyannoteAI voiceprint stored on a fresh
 *    `unconfirmed` profile so the next recording auto-identifies them;
 *  - speakers too brief to enroll still get an `unconfirmed` profile (no
 *    voiceprint), matching the embedding path's "one profile per heard voice".
 *
 * Occurrences carry a null embedding — the hosted API exposes none.
 */
@Injectable()
export class VoiceprintMatcherService {
  private readonly logger = new Logger(VoiceprintMatcherService.name);
  private readonly sidecarUrl: string;
  private readonly sidecarToken: string;
  private readonly sidecarTimeoutMs: number;
  private readonly minEnrollSeconds: number;
  private readonly voiceprintMaxSeconds: number;

  constructor(
    config: ConfigService,
    private readonly storage: StorageService,
    private readonly pyannote: PyannoteAiClient,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {
    this.sidecarUrl = config.get<string>('SPEAKER_ID_URL', 'http://localhost:8000');
    this.sidecarToken = config.get<string>('SPEAKER_ID_TOKEN', '');
    this.sidecarTimeoutMs = Number(config.get<string>('SPEAKER_ID_TIMEOUT_MS', String(30 * 60_000)));
    this.minEnrollSeconds = Number(config.get<string>('PYANNOTEAI_MIN_ENROLL_SECONDS', '6'));
    this.voiceprintMaxSeconds = Number(config.get<string>('PYANNOTEAI_VOICEPRINT_MAX_SECONDS', '30'));
  }

  async assignSpeakers(job: SpeakerIdentificationJob, speakers: DiarizedSpeakerLite[]): Promise<void> {
    // Queue retries after a partial failure re-run the whole assignment.
    await this.occurrences.delete({ extractionId: job.extractionId });
    if (speakers.length === 0) return;

    const enrolled = await this.enrollNewSpeakers(job, speakers);

    for (const speaker of speakers) {
      let profile = speaker.matchedProfile;
      if (!profile) {
        profile = await this.profiles.save(
          this.profiles.create({
            userId: job.userId,
            name: null,
            status: 'unconfirmed',
            centroid: null,
            embeddingCount: 0,
            voiceprint: enrolled.get(speaker.label) ?? null,
          }),
        );
      }
      await this.occurrences.save(
        this.occurrences.create({
          inboxItemId: job.inboxItemId,
          extractionId: job.extractionId,
          voiceProfileId: profile.id,
          label: speaker.label,
          embedding: null,
          speakingSeconds: speaker.speakingSeconds,
          similarity: speaker.matchedProfile ? 1 : null,
        }),
      );
    }
  }

  /**
   * Enroll a voiceprint for every unmatched speaker with enough clean speech.
   * One sidecar call slices all of them from a single audio download; each clip
   * is uploaded, voiceprinted, then deleted. Best-effort: a speaker whose
   * enrollment fails simply gets no voiceprint (still a profile, just not
   * matchable next time) rather than failing the whole diarization.
   */
  private async enrollNewSpeakers(
    job: SpeakerIdentificationJob,
    speakers: DiarizedSpeakerLite[],
  ): Promise<Map<string, string>> {
    const enrolled = new Map<string, string>();
    const candidates = speakers.filter(
      (s) => !s.matchedProfile && s.speakingSeconds >= this.minEnrollSeconds,
    );
    if (candidates.length === 0) return enrolled;

    let clips: SidecarClip[];
    try {
      const internalUrl = await this.storage.createInternalPresignedGetUrl(job.storageKey);
      const res = await postJsonToSidecar<{ clips: SidecarClip[] }>(
        `${this.sidecarUrl}/voiceprint-clips`,
        {
          audio_url: internalUrl,
          max_seconds: this.voiceprintMaxSeconds,
          speakers: candidates.map((c) => ({ label: c.label, segments: c.segments })),
        },
        this.sidecarToken,
        this.sidecarTimeoutMs,
      );
      clips = res.clips ?? [];
    } catch (err) {
      this.logger.warn(`voiceprint clip extraction failed, skipping enrollment: ${(err as Error).message}`);
      return enrolled;
    }

    for (const clip of clips) {
      try {
        // Upload the clip straight to pyannoteAI — no temp object in our storage.
        const mediaUrl = await this.pyannote.upload(
          Buffer.from(clip.audio_base64, 'base64'),
          'audio/wav',
          randomUUID(),
        );
        enrolled.set(clip.label, await this.pyannote.voiceprint(mediaUrl));
      } catch (err) {
        this.logger.warn(`voiceprint enrollment failed for ${clip.label}: ${(err as Error).message}`);
      }
    }
    return enrolled;
  }
}
