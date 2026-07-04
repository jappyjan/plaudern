import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
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

  /**
   * Re-run speaker diarization for an item. Extractions are append-only, so a
   * retry simply enqueues a fresh row; older attempts stay in history. The
   * transcript merge and (via the summarization trigger) a fresh summary follow
   * automatically once the new diarization lands.
   */
  async retryDiarization(userId: string, inboxItemId: string): Promise<string> {
    if (this.disabled) {
      throw new BadRequestException('speaker identification is disabled on this server');
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
    // Not disabled (checked above), so enqueueDiarization returns a real id.
    return (await this.enqueueDiarization(item.id, {
      storageKey: source.storageKey,
      contentType: source.contentType,
    })) as string;
  }
}
