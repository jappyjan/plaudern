import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboxService } from '@plaudern/inbox';
import { DIARIZATION_PROVIDER, type DiarizationProvider } from './diarization.provider';
import { DIARIZATION_QUEUE, type DiarizationQueue } from './diarization.job';

export interface EnqueueDiarizationParams {
  storageKey: string;
  contentType: string;
}

/**
 * Public entry point invoked by ingestion at commit time, mirroring
 * TranscriptionService: appends a `queued` diarization extraction row and
 * hands the job to the queue. No-op when speaker identification is disabled.
 */
@Injectable()
export class SpeakerIdService {
  private readonly disabled: boolean;

  constructor(
    config: ConfigService,
    private readonly inbox: InboxService,
    @Inject(DIARIZATION_PROVIDER)
    private readonly provider: DiarizationProvider,
    @Inject(DIARIZATION_QUEUE)
    private readonly queue: DiarizationQueue,
  ) {
    this.disabled = config.get<string>('SPEAKER_ID_PROVIDER', 'pyannote') === 'off';
  }

  async enqueueDiarization(
    inboxItemId: string,
    params: EnqueueDiarizationParams,
  ): Promise<string | null> {
    if (this.disabled) return null;
    const extraction = await this.inbox.addExtraction(inboxItemId, 'diarization', this.provider.id);
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      storageKey: params.storageKey,
      contentType: params.contentType,
    });
    return extraction.id;
  }
}
