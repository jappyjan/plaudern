import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboxService } from '@plaudern/inbox';
import { SPEAKER_IDENTIFIER, type SpeakerIdentifier } from './speaker-identifier';
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
    @Inject(SPEAKER_IDENTIFIER)
    private readonly identifier: SpeakerIdentifier,
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
