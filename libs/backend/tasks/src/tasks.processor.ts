import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionSegment, TaskExtractionPayload } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import {
  TASK_EXTRACTION_PROVIDER,
  type TaskExtractionProvider,
} from './tasks.provider';
import { Inject } from '@nestjs/common';
import { TasksRegistryService, type TaskCandidate } from './tasks-registry.service';
import { TaskContextService } from './task-context';
import type { TaskExtractionJob } from './tasks.job';

/**
 * Executes one task-extraction job (JJ-35): rebuild the extraction input from
 * the item's latest succeeded summary/transcription, run the LLM provider to
 * pull the speaker's intentions, locate each intention's source sentence in the
 * transcript segments (for a deep-linkable citation), and dedupe the candidates
 * into the per-user task list via `TasksRegistryService`. The parent `tasks`
 * extraction row records provenance in `content`. Shared by the inline and
 * BullMQ queues.
 */
@Injectable()
export class TasksProcessor {
  private readonly logger = new Logger(TasksProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly registry: TasksRegistryService,
    @Inject(TASK_EXTRACTION_PROVIDER)
    private readonly provider: TaskExtractionProvider,
    private readonly context: TaskContextService,
  ) {}

  async process(job: TaskExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const ctx = await this.context.build(item);
      if (!ctx) {
        throw new Error('no succeeded summary or transcription to extract tasks from');
      }

      // Owner not anchored for this item → ingest zero tasks (which supersedes
      // any stale/mis-attributed ones) rather than guessing whose tasks these are.
      const result =
        ctx.kind === 'ready'
          ? await this.provider.extract(ctx.input)
          : { tasks: [], model: this.provider.id };
      const segments = transcriptionSegments(item);
      const candidates: TaskCandidate[] = result.tasks.map((task) => {
        const located = task.quote ? locateQuote(segments, task.quote) : null;
        return {
          title: task.title,
          dueDate: task.dueDate ?? null,
          quote: task.quote ?? null,
          startSeconds: located?.start ?? null,
          endSeconds: located?.end ?? null,
        };
      });

      const taskCount = await this.registry.ingest(
        item.userId,
        item.id,
        job.extractionId,
        candidates,
      );

      const payload: TaskExtractionPayload = {
        model: result.model ?? this.provider.id,
        taskCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(`extracted ${taskCount} task(s) from inbox item ${job.inboxItemId}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`task extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

/** The latest succeeded transcription's timed segments, if any. */
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
 * matching segments, or null when the quote can't be located.
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
