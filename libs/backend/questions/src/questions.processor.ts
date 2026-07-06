import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { QuestionExtractionPayload } from '@plaudern/contracts';
import {
  QUESTION_EXTRACTION_PROVIDER,
  type QuestionExtractionProvider,
} from './questions.provider';
import { QuestionContextService } from './question-context';
import { QuestionsPersistenceService } from './questions-persistence.service';
import type { QuestionExtractionJob } from './questions.job';

/**
 * Executes one question-extraction job (JJ-34): rebuild the speaker-attributed
 * transcript from the item's latest transcription + diarization, run the LLM
 * provider, then upsert the questions into the user-scoped `questions` table
 * (preserving user `dropped` decisions on re-runs). The parent `questions`
 * extraction row records provenance in `content`. Shared by the inline and
 * BullMQ queues.
 *
 * Depends on QuestionsPersistenceService — NOT on QuestionsService — so the
 * module graph stays acyclic: the service injects the queue, whose factory
 * injects this processor, and an edge from here back to the service would
 * deadlock Nest's module compile (mirrors the commitments processor).
 */
@Injectable()
export class QuestionsProcessor {
  private readonly logger = new Logger(QuestionsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: QuestionContextService,
    private readonly persistence: QuestionsPersistenceService,
    @Inject(QUESTION_EXTRACTION_PROVIDER)
    private readonly provider: QuestionExtractionProvider,
  ) {}

  async process(job: QuestionExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = await this.context.build(item);
      if (!input) {
        throw new Error('no succeeded transcription to extract questions from');
      }

      const result = await runWithAiAudit(
        { userId: item.userId, itemId: item.id, kind: 'questions' },
        () => this.provider.extract(item.userId, input),
      );
      const questionCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        result.questions,
      );

      const payload: QuestionExtractionPayload = {
        model: result.model ?? this.provider.id,
        questionCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${questionCount} question(s) from inbox item ${job.inboxItemId}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`question extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}
