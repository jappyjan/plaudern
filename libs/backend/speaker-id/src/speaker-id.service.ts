import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';
import { DIARIZATION_QUEUE, type DiarizationQueue } from './diarization.job';

export interface EnqueueDiarizationParams {
  storageKey: string;
  contentType: string;
}

/**
 * Version of the diarization extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves so backfill runs
 * can catch older items up.
 */
export const DIARIZATION_EXTRACTOR_VERSION = 1;

/**
 * Public entry point invoked by ingestion at commit time, mirroring
 * TranscriptionService: appends a `queued` diarization extraction row and
 * hands the job to the queue. No-op when speaker identification is not
 * configured for the user (no `speaker_id` provider assigned).
 */
@Injectable()
export class SpeakerIdService {
  constructor(
    private readonly inbox: InboxService,
    private readonly aiConfig: AiConfigService,
    private readonly identifier: PyannoteAiSpeakerIdentifier,
    @Inject(DIARIZATION_QUEUE)
    private readonly queue: DiarizationQueue,
  ) {}

  /** Whether speaker identification is configured for this user. */
  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'speaker_id');
  }

  async enqueueDiarization(
    userId: string,
    inboxItemId: string,
    params: EnqueueDiarizationParams,
  ): Promise<string | null> {
    if (!(await this.aiConfig.isEnabled(userId, 'speaker_id'))) return null;
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'diarization',
      this.identifier.id,
      DIARIZATION_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      storageKey: params.storageKey,
      contentType: params.contentType,
    });
    return extraction.id;
  }

  /**
   * Re-run speaker diarization for an item. Extractions are append-only, so a
   * retry simply enqueues a fresh row; older attempts stay in history. The
   * transcript merge and (via the summarization trigger) a fresh summary follow
   * automatically once the new diarization lands.
   */
  async retryDiarization(userId: string, inboxItemId: string): Promise<string> {
    if (!(await this.aiConfig.isEnabled(userId, 'speaker_id'))) {
      throw new BadRequestException(
        'speaker identification is not configured (assign a provider in Settings → AI)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const source = item.source;
    if (
      !source ||
      source.uploadStatus !== 'committed' ||
      !source.contentType.startsWith('audio/')
    ) {
      throw new BadRequestException('item has no committed audio source to diarize');
    }
    const latest = item.extractions
      .filter((e) => e.kind === 'diarization')
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (latest && (latest.status === 'queued' || latest.status === 'processing')) {
      throw new ConflictException('speaker identification is already in progress');
    }
    // Enabled (checked above), so enqueueDiarization returns a real id.
    return (await this.enqueueDiarization(userId, item.id, {
      storageKey: source.storageKey,
      contentType: source.contentType,
    })) as string;
  }
}
