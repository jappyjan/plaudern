import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { TEXT_PASSTHROUGH_PROVIDER_ID } from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import {
  TRANSCRIPTION_PROVIDER,
  type TranscriptionProvider,
} from './transcription.provider';
import { TRANSCRIPTION_QUEUE, type TranscriptionQueue } from './transcription.job';

export interface EnqueueParams {
  /** Owner of the item; selects the per-user transcription provider/config. */
  userId: string;
  storageKey: string;
  contentType: string;
  filename?: string;
  languageHint?: string;
  /** Copy the stored text blob into the row instead of calling the provider. */
  passthrough?: boolean;
}

/**
 * Version of the transcription extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves (e.g. a better
 * model) so backfill runs can catch older items up.
 */
export const TRANSCRIPTION_EXTRACTOR_VERSION = 1;

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
    const provider = params.passthrough
      ? TEXT_PASSTHROUGH_PROVIDER_ID
      : await this.provider.providerId(params.userId);
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'transcription',
      provider,
      TRANSCRIPTION_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      userId: params.userId,
      storageKey: params.storageKey,
      contentType: params.contentType,
      filename: params.filename,
      languageHint: params.languageHint,
      passthrough: params.passthrough,
    });
    return extraction.id;
  }

  /**
   * Record text that was already extracted by another step (e.g. OCR) as a
   * succeeded passthrough `transcription` row, so the downstream DAG (summary,
   * topics, entities, embeddings, …) runs on documents exactly as it does for
   * typed notes. No provider/queue involved: the text is written straight onto
   * the row, mirroring the passthrough branch in `TranscriptionProcessor`.
   *
   * Marked with `TEXT_PASSTHROUGH_PROVIDER_ID` so the summary context steers the
   * prompt off "recording" (it is typed/scanned text, not speech).
   */
  async recordExtractedText(
    inboxItemId: string,
    params: { content: string; language?: string | null },
  ): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'transcription',
      TEXT_PASSTHROUGH_PROVIDER_ID,
      TRANSCRIPTION_EXTRACTOR_VERSION,
    );
    await this.inbox.completeExtraction(extraction.id, {
      status: 'succeeded',
      content: params.content,
      language: params.language ?? undefined,
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
      userId,
      storageKey: source.storageKey,
      contentType: source.contentType,
      filename: source.originalFilename ?? undefined,
    });
  }
}
