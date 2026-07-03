import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
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

  /**
   * Re-run transcription for an item. Extractions are append-only, so a retry
   * simply enqueues a fresh row; older attempts stay visible in the history.
   */
  async retryTranscription(userId: string, inboxItemId: string): Promise<string> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const source = item.source;
    if (
      !source ||
      source.uploadStatus !== 'committed' ||
      !source.contentType.startsWith('audio/')
    ) {
      throw new BadRequestException('item has no committed audio source to transcribe');
    }
    const latest = item.extractions
      .filter((e) => e.kind === 'transcription')
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (latest && (latest.status === 'queued' || latest.status === 'processing')) {
      throw new ConflictException('a transcription is already in progress');
    }
    return this.enqueueTranscription(item.id, {
      storageKey: source.storageKey,
      contentType: source.contentType,
      filename: source.originalFilename ?? undefined,
    });
  }
}
