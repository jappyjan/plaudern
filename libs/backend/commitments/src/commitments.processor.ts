import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { CommitmentExtractionPayload, ExtractionSegment } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import {
  COMMITMENT_EXTRACTION_PROVIDER,
  type CommitmentExtractionProvider,
} from './commitments.provider';
import { CommitmentContextService } from './commitment-context';
import { CommitmentsPersistenceService } from './commitments-persistence.service';
import { CommitmentTaskDedupeService } from './commitment-task-dedupe.service';
import type { CommitmentExtractionJob } from './commitments.job';

/**
 * Executes one commitment-extraction job: rebuild the speaker-attributed
 * transcript from the item's latest transcription + diarization, run the LLM
 * provider, then resolve relative due dates and upsert the commitments into the
 * user-scoped `commitments` table (preserving user statuses on re-runs). The
 * parent `commitments` extraction row records provenance in `content`. Shared
 * by the inline and BullMQ queues.
 *
 * Depends on CommitmentsPersistenceService — NOT on CommitmentsService — so
 * the module graph stays acyclic: the service injects the queue, whose factory
 * injects this processor, and an edge from here back to the service would
 * deadlock Nest's module compile (mirrors how the topics processor never
 * depends on TopicsService).
 */
@Injectable()
export class CommitmentsProcessor {
  private readonly logger = new Logger(CommitmentsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: CommitmentContextService,
    private readonly persistence: CommitmentsPersistenceService,
    private readonly dedupe: CommitmentTaskDedupeService,
    @Inject(COMMITMENT_EXTRACTION_PROVIDER)
    private readonly provider: CommitmentExtractionProvider,
  ) {}

  async process(job: CommitmentExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const ctx = await this.context.build(item);
      if (!ctx) {
        throw new Error('no succeeded transcription to extract commitments from');
      }

      // Owner not anchored for this item → persist zero commitments (which reaps
      // any stale/previously mis-attributed ones) rather than guessing direction.
      const result =
        ctx.kind === 'ready'
          ? await runWithAiAudit(
              { userId: item.userId, itemId: item.id, kind: 'commitments' },
              () => this.provider.extract(item.userId, ctx.input),
            )
          : { commitments: [], model: this.provider.id };
      // Resolve each commitment's `sourceTimestamp` STRUCTURALLY (JJ-71): the
      // model is never asked for a timestamp (unreliable) — instead we locate its
      // `sourceQuote` in the transcription's timed segments, the same
      // quote→timestamp mapping the tasks/facts extractors use for deep-linkable
      // citations. Runs on first extraction AND on every re-extraction (backfill
      // bumps the version), so older items get backfilled through the normal path.
      const segments = transcriptionSegments(item);
      const commitments = result.commitments.map((commitment) => ({
        ...commitment,
        sourceTimestamp: commitment.sourceQuote
          ? locateQuote(segments, commitment.sourceQuote)?.start ?? null
          : null,
      }));
      const commitmentCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        ctx.kind === 'ready' ? ctx.input.occurredAt : undefined,
        commitments,
      );

      // Best-effort: collapse owed_by_me commitments that duplicate one of the
      // item's tasks (its `tasks: settled` dependency guarantees they exist by
      // now). A dedupe failure must not fail the extraction — the commitments
      // are already persisted; the only cost is a duplicate lingering.
      try {
        await this.dedupe.reconcile(item.userId, item.id);
      } catch (err) {
        this.logger.warn(
          `commitment/task dedupe failed for ${job.inboxItemId}: ${(err as Error).message}`,
        );
      }

      const payload: CommitmentExtractionPayload = {
        model: result.model ?? this.provider.id,
        commitmentCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${commitmentCount} commitment(s) from inbox item ${job.inboxItemId}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`commitment extraction failed for ${job.inboxItemId}: ${message}`);
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
