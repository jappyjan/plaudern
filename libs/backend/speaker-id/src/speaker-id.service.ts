import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
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
