import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SpeakerOccurrenceEntity, VoiceProfileEntity } from '@plaudern/persistence';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { CLIP_EXTRACTOR, type ClipExtractor, type VoiceprintClip } from './clip-extractor';
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

/**
 * Persists pyannoteAI diarization/identification results:
 *
 *  - matched speakers link to their existing profile;
 *  - each new speaker with enough clean speech is auto-enrolled — its longest
 *    segments are sliced into a clip by ffmpeg, uploaded, and turned into a
 *    pyannoteAI voiceprint stored on a fresh `unconfirmed` profile so the next
 *    recording auto-identifies them;
 *  - speakers too brief to enroll still get an `unconfirmed` profile (no
 *    voiceprint) — one profile per heard voice.
 */
@Injectable()
export class VoiceprintMatcherService {
  private readonly logger = new Logger(VoiceprintMatcherService.name);
  private readonly minEnrollSeconds: number;
  private readonly voiceprintMaxSeconds: number;

  constructor(
    config: ConfigService,
    private readonly pyannote: PyannoteAiClient,
    @Inject(CLIP_EXTRACTOR)
    private readonly clips: ClipExtractor,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {
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
          speakingSeconds: speaker.speakingSeconds,
          similarity: speaker.matchedProfile ? 1 : null,
        }),
      );
    }
  }

  /**
   * Enroll a voiceprint for every unmatched speaker with enough clean speech.
   * The audio is downloaded once and all clips sliced from it; each clip is
   * uploaded, voiceprinted, then discarded. Best-effort: a speaker whose
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

    let clips: VoiceprintClip[];
    try {
      clips = await this.clips.extract(
        job.storageKey,
        candidates.map((c) => ({ label: c.label, segments: c.segments })),
        this.voiceprintMaxSeconds,
      );
    } catch (err) {
      this.logger.warn(`voiceprint clip extraction failed, skipping enrollment: ${(err as Error).message}`);
      return enrolled;
    }

    for (const clip of clips) {
      try {
        // Upload the clip straight to pyannoteAI — no temp object in our storage.
        const mediaUrl = await this.pyannote.upload(clip.wav, 'audio/wav', randomUUID());
        enrolled.set(clip.label, await this.pyannote.voiceprint(mediaUrl));
      } catch (err) {
        this.logger.warn(`voiceprint enrollment failed for ${clip.label}: ${(err as Error).message}`);
      }
    }
    return enrolled;
  }
}
