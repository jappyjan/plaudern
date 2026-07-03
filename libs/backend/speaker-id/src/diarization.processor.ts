import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import { DIARIZATION_PROVIDER, type DiarizationProvider } from './diarization.provider';
import type { DiarizationJob } from './diarization.job';
import { ProfileMatcherService } from './profile-matcher.service';

/**
 * Executes a single diarization job: hand the provider a presigned audio URL,
 * link the returned speakers to voice profiles, and write the speaker-labeled
 * segments onto the append-only extraction row. Shared by the inline and
 * BullMQ queues.
 */
@Injectable()
export class DiarizationProcessor {
  private readonly logger = new Logger(DiarizationProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    private readonly matcher: ProfileMatcherService,
    @Inject(DIARIZATION_PROVIDER)
    private readonly provider: DiarizationProvider,
  ) {}

  async process(job: DiarizationJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      // Jobs carry only the item id; recover the owner so voice profiles are
      // matched within — and only within — that user's contact book.
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');
      // Presign at run time (not enqueue time) so queue retries never hold an
      // expired URL. Internal endpoint: the sidecar sits on the server network.
      const audioUrl = await this.storage.createInternalPresignedGetUrl(job.storageKey);
      const result = await this.provider.diarize({ audioUrl, contentType: job.contentType });
      await this.matcher.assignSpeakers(
        item.userId,
        job.inboxItemId,
        job.extractionId,
        result.speakers,
      );
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        segments: result.segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker })),
      });
      this.logger.log(
        `diarized inbox item ${job.inboxItemId}: ${result.speakers.length} speaker(s)`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`diarization failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}
