import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { StorageService } from '@plaudern/storage';
import { VoiceProfileEntity } from '@plaudern/persistence';
import type { PyannoteAiDiarization } from '../providers/pyannoteai-client';
import { PyannoteAiClient } from '../providers/pyannoteai-client';
import type {
  SpeakerIdentificationJob,
  SpeakerIdentificationResult,
  SpeakerIdentifier,
} from '../speaker-identifier';
import {
  VoiceprintMatcherService,
  type DiarizedSpeakerLite,
} from '../voiceprint-matcher.service';

/**
 * `pyannoteai` mode: diarization + cross-recording identity via the hosted
 * pyannoteAI API. Voiceprints of known profiles are passed to /identify so
 * matching happens server-side; unknown speakers are enrolled by the matcher.
 *
 * pyannoteAI fetches the audio itself over the public internet, so this hands
 * it the PUBLIC presigned URL (createPresignedGetUrl) — the internal one points
 * at a host only the local network can reach. This means pyannoteai mode
 * requires storage whose presigned URLs are publicly reachable (S3, or MinIO
 * behind a public S3_PUBLIC_ENDPOINT).
 */
@Injectable()
export class PyannoteAiSpeakerIdentifier implements SpeakerIdentifier {
  readonly id = 'pyannoteai';

  private readonly threshold: number;

  constructor(
    config: ConfigService,
    private readonly storage: StorageService,
    private readonly client: PyannoteAiClient,
    private readonly matcher: VoiceprintMatcherService,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
  ) {
    // pyannoteAI's confidence scale differs from cosine, so it has its own knob
    // and default (0 = accept pyannoteAI's own best match).
    this.threshold = Number(config.get<string>('PYANNOTEAI_MATCH_THRESHOLD', '0'));
  }

  async identify(job: SpeakerIdentificationJob): Promise<SpeakerIdentificationResult> {
    const audioUrl = await this.storage.createPresignedGetUrl(job.storageKey);

    // Known profiles with a voiceprint become /identify candidates, keyed by id.
    const known = await this.profiles.find({
      where: { userId: job.userId, voiceprint: Not(IsNull()) },
    });
    const knownById = new Map(known.map((p) => [p.id, p]));

    const diar =
      known.length > 0
        ? await this.client.identify(
            audioUrl,
            known.map((p) => ({ label: p.id, voiceprint: p.voiceprint as string })),
            this.threshold,
          )
        : await this.client.diarize(audioUrl);

    const speakers = this.groupSpeakers(diar, knownById);
    await this.matcher.assignSpeakers(job, speakers);

    // Segments carry the canonical labels the matcher persisted as occurrences.
    const canonicalByRaw = new Map(speakers.flatMap((s) => s.rawLabels.map((r) => [r, s.label])));
    return {
      durationSeconds: diar.durationSeconds,
      segments: diar.segments.map((s) => ({
        start: s.start,
        end: s.end,
        speaker: canonicalByRaw.get(s.speaker) ?? s.speaker,
      })),
    };
  }

  /**
   * Collapse raw pyannoteAI labels into canonical SPEAKER_00/01/... in order of
   * first appearance, tag each with its matched profile (if the raw label was a
   * known voiceprint id), and sum speaking time + segments for enrollment.
   */
  private groupSpeakers(
    diar: PyannoteAiDiarization,
    knownById: Map<string, VoiceProfileEntity>,
  ): (DiarizedSpeakerLite & { rawLabels: string[] })[] {
    const byRaw = new Map<string, DiarizedSpeakerLite & { rawLabels: string[] }>();
    let order = 0;
    for (const seg of diar.segments) {
      let speaker = byRaw.get(seg.speaker);
      if (!speaker) {
        const canonical = `SPEAKER_${String(order).padStart(2, '0')}`;
        order += 1;
        speaker = {
          label: canonical,
          speakingSeconds: 0,
          segments: [],
          matchedProfile: knownById.get(seg.speaker) ?? null,
          rawLabels: [seg.speaker],
        };
        byRaw.set(seg.speaker, speaker);
      }
      speaker.speakingSeconds += Math.max(0, seg.end - seg.start);
      speaker.segments.push({ start: seg.start, end: seg.end });
    }
    return [...byRaw.values()];
  }
}
