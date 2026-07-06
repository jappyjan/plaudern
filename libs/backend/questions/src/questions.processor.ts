import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionSegment, QuestionExtractionPayload } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
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
      // Resolve each question's `sourceTimestamp` STRUCTURALLY (JJ-71): the model
      // is never asked for a timestamp (unreliable) — instead we locate its
      // `sourceQuote` in the transcription's timed segments, the same
      // quote→timestamp mapping the tasks/facts extractors use for deep-linkable
      // citations. Runs on first extraction AND on every re-extraction (backfill
      // bumps the version), so older items get backfilled through the normal path.
      const segments = transcriptionSegments(item);
      const questions = result.questions.map((question) => ({
        ...question,
        sourceTimestamp: question.sourceQuote
          ? locateQuote(segments, question.sourceQuote)?.start ?? null
          : null,
      }));
      const questionCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        questions,
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

/** The latest succeeded transcription's timed segments, if any. Mirrors the tasks/facts processor helper. */
function transcriptionSegments(item: InboxItemEntity): ExtractionSegment[] {
  const transcription = (item.extractions ?? [])
    .filter((e: ExtractedPayloadEntity) => e.kind === 'transcription' && e.status === 'succeeded')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return transcription?.segments ?? [];
}

/**
 * Best-effort mapping of a quoted sentence back to the transcript segment(s) it
 * came from, so a citation can deep-link into the audio. Matches on normalized
 * substring containment in either direction; returns the span covering all
 * matching segments, or null when the quote can't be located. Mirrors the
 * tasks/facts processor helper (the same quote→timestamp resolution memory-chat
 * citations get from their embedding chunks).
 */
export function locateQuote(
  segments: ExtractionSegment[],
  quote: string,
): { start: number; end: number } | null {
  const needle = normalizeText(quote);
  if (!needle) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const segment of segments) {
    const hay = normalizeText(segment.text ?? '');
    if (!hay) continue;
    if (hay.includes(needle) || needle.includes(hay)) {
      start = start === null ? segment.start : Math.min(start, segment.start);
      end = end === null ? segment.end : Math.max(end, segment.end);
    }
  }
  if (start === null || end === null) return null;
  return { start, end };
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
