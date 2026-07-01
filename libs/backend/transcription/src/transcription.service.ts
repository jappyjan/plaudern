import { Inject, Injectable } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import {
  TRANSCRIPTION_PROVIDER,
  type TranscriptionProvider,
} from './transcription.provider';
import { TRANSCRIPTION_QUEUE, type TranscriptionQueue } from './transcription.job';

export interface EnqueueParams {
  storageKey: string;
  contentType: string;
  filename?: string;
  languageHint?: string;
}

/**
 * Public entry point invoked by ingestion at commit time. Appends a `queued`
 * extraction row and hands the job to the queue (plan §2/§5).
 */
@Injectable()
export class TranscriptionService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly provider: TranscriptionProvider,
    @Inject(TRANSCRIPTION_QUEUE)
    private readonly queue: TranscriptionQueue,
  ) {}

  async enqueueTranscription(inboxItemId: string, params: EnqueueParams): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'transcription',
      this.provider.id,
    );
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      storageKey: params.storageKey,
      contentType: params.contentType,
      filename: params.filename,
      languageHint: params.languageHint,
    });
    return extraction.id;
  }
}
