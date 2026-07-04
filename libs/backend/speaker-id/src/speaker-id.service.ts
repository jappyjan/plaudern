import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboxService } from '@plaudern/inbox';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';
import { DIARIZATION_QUEUE, type DiarizationQueue } from './diarization.job';

export interface EnqueueDiarizationParams {
  storageKey: string;
  contentType: string;
}

/**
 * Public entry point invoked by ingestion at commit time, mirroring
 * TranscriptionService: appends a `queued` diarization extraction row and
 * hands the job to the queue. No-op when speaker identification is disabled
 * (SPEAKER_ID_PROVIDER=off).
 */
@Injectable()
export class SpeakerIdService {
  private readonly disabled: boolean;

  constructor(
    config: ConfigService,
    private readonly inbox: InboxService,
    private readonly identifier: PyannoteAiSpeakerIdentifier,
    @Inject(DIARIZATION_QUEUE)
    private readonly queue: DiarizationQueue,
  ) {
    // Fail fast on values from removed provider modes so a stale deployment
    // config surfaces at boot, not as silently-different behavior.
    const selected = config.get<string>('SPEAKER_ID_PROVIDER', 'pyannoteai');
    if (selected === 'pyannote' || selected === 'stub') {
      throw new Error(
        `SPEAKER_ID_PROVIDER=${selected} was removed; use 'pyannoteai' (requires PYANNOTEAI_API_KEY) or 'off'`,
      );
    }
    if (selected !== 'pyannoteai' && selected !== 'off') {
      throw new Error(
        `unknown SPEAKER_ID_PROVIDER '${selected}' (expected 'pyannoteai' or 'off')`,
      );
    }
    this.disabled = selected === 'off';
  }

  async enqueueDiarization(
    inboxItemId: string,
    params: EnqueueDiarizationParams,
  ): Promise<string | null> {
    if (this.disabled) return null;
    const extraction = await this.inbox.addExtraction(inboxItemId, 'diarization', this.identifier.id);
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      storageKey: params.storageKey,
      contentType: params.contentType,
    });
    return extraction.id;
  }
}
