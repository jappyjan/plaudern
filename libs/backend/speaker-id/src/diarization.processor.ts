import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { DiarizationJob } from './diarization.job';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';

/**
 * Executes a single diarization job: delegate to the speaker identifier, which
 * diarizes the recording and links speakers to voice profiles, then write the
 * speaker-labeled segments onto the append-only extraction row. Shared by the
 * inline and BullMQ queues.
 */
@Injectable()
export class DiarizationProcessor {
  private readonly logger = new Logger(DiarizationProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly identifier: PyannoteAiSpeakerIdentifier,
  ) {}

  async process(job: DiarizationJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      // Jobs carry only the item id; recover the owner so voice profiles are
      // matched within — and only within — that user's contact book.
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');
      // The identifier uploads the audio at run time (not enqueue time) so
      // queue retries never hold stale state.
      const result = await this.identifier.identify({
        userId: item.userId,
        inboxItemId: job.inboxItemId,
        extractionId: job.extractionId,
        storageKey: job.storageKey,
        contentType: job.contentType,
      });
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        segments: result.segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker })),
      });
      const speakerCount = new Set(result.segments.map((s) => s.speaker)).size;
      this.logger.log(`diarized inbox item ${job.inboxItemId}: ${speakerCount} speaker(s)`);
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
