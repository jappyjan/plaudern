import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import type { DiarizationJob } from './diarization.job';
import { SPEAKER_IDENTIFIER, type SpeakerIdentifier } from './speaker-identifier';

/**
 * Executes a single diarization job: delegate to the configured speaker
 * identifier (local embeddings or hosted voiceprints), which diarizes the
 * recording and links speakers to voice profiles, then write the
 * speaker-labeled segments onto the append-only extraction row. Shared by the
 * inline and BullMQ queues.
 */
@Injectable()
export class DiarizationProcessor {
  private readonly logger = new Logger(DiarizationProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    @Inject(SPEAKER_IDENTIFIER)
    private readonly identifier: SpeakerIdentifier,
  ) {}

  async process(job: DiarizationJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      // Presigning happens inside the identifier at run time (not enqueue time)
      // so queue retries never hold an expired URL, and each provider chooses
      // the internal vs public endpoint it needs.
      const result = await this.identifier.identify({
        userId: DEFAULT_USER_ID,
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
