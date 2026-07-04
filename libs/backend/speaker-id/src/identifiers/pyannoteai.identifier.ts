import { randomUUID } from 'node:crypto';
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
 * Audio is uploaded to pyannoteAI's own storage (PyannoteAiClient.upload) and
 * referenced by a `media://` handle, rather than handing pyannoteAI a presigned
 * URL into our storage. This keeps our S3/MinIO fully private — it never needs
 * a public endpoint for this feature and no link to it leaves the box.
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
    // pyannoteAI's confidence scale (0-100) differs from cosine, so it has its
    // own knob. It is passed to /identify as matching.threshold: the minimum
    // confidence to accept a voiceprint match. 0 means "always take the closest
    // voiceprint no matter how low the confidence", which — with exclusive
    // matching — forces every known voice onto some speaker in every recording.
    // Default to pyannoteAI's recommended strict-matching floor so a voice only
    // matches when it's actually present; raise toward 70 for stricter, lower
    // for more lenient.
    this.threshold = Number(config.get<string>('PYANNOTEAI_MATCH_THRESHOLD', '50'));
  }

  async identify(job: SpeakerIdentificationJob): Promise<SpeakerIdentificationResult> {
    // Push the bytes to pyannoteAI (private storage stays private) and work off
    // the returned media:// handle.
    const bytes = await this.readObject(job.storageKey);
    const audioUrl = await this.client.upload(bytes, job.contentType, randomUUID());

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

  private async readObject(storageKey: string): Promise<Buffer> {
    const stream = await this.storage.getObjectStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
