import { Inject, Injectable } from '@nestjs/common';
import { StorageService } from '@plaudern/storage';
import { DIARIZATION_PROVIDER, type DiarizationProvider } from '../diarization.provider';
import { ProfileMatcherService } from '../profile-matcher.service';
import type {
  SpeakerIdentificationJob,
  SpeakerIdentificationResult,
  SpeakerIdentifier,
} from '../speaker-identifier';

/**
 * `pyannote` mode: the self-hosted sidecar diarizes and returns one embedding
 * per speaker, then ProfileMatcher links them to profiles by cosine similarity.
 * This preserves the original behavior verbatim behind the SpeakerIdentifier
 * seam. The sidecar sits on the internal network, so it gets the internal
 * presigned URL.
 */
@Injectable()
export class EmbeddingSpeakerIdentifier implements SpeakerIdentifier {
  readonly id: string;

  constructor(
    private readonly storage: StorageService,
    private readonly matcher: ProfileMatcherService,
    @Inject(DIARIZATION_PROVIDER)
    private readonly provider: DiarizationProvider,
  ) {
    this.id = provider.id;
  }

  async identify(job: SpeakerIdentificationJob): Promise<SpeakerIdentificationResult> {
    const audioUrl = await this.storage.createInternalPresignedGetUrl(job.storageKey);
    const result = await this.provider.diarize({ audioUrl, contentType: job.contentType });
    await this.matcher.assignSpeakers(
      job.userId,
      job.inboxItemId,
      job.extractionId,
      result.speakers,
    );
    return { durationSeconds: result.durationSeconds, segments: result.segments };
  }
}
