import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import {
  summaryPayloadSchema,
  type ExtractionStatus,
  type SummaryDto,
} from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import {
  SUMMARIZATION_PROVIDER,
  type SummarizationProvider,
} from './summarization.provider';
import { SUMMARIZATION_QUEUE, type SummarizationQueue } from './summarization.job';
import { SummaryContextService } from './summary-context.service';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the summary extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const SUMMARY_EXTRACTOR_VERSION = 1;

/**
 * Owns the summarization pipeline step. WHEN a summary runs is decided by the
 * extraction DAG (`SummaryExtractor` + the generic pipeline in
 * `@plaudern/extraction`, which replaced the bespoke SummarizationTrigger);
 * this service owns HOW: enqueueing, the manual retry, and the read model
 * backing the summary tab.
 */
@Injectable()
export class SummarizationService {
  constructor(
    private readonly inbox: InboxService,
    private readonly context: SummaryContextService,
    private readonly aiConfig: AiConfigService,
    @Inject(SUMMARIZATION_PROVIDER)
    private readonly provider: SummarizationProvider,
    @Inject(SUMMARIZATION_QUEUE)
    private readonly queue: SummarizationQueue,
  ) {}

  /** Whether summarization is configured for this user. */
  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'summarization');
  }

  /**
   * Manually (re)generate the summary for an item — e.g. after a failure or to
   * get a fresh take. Appends a new summary row; older ones stay in history.
   */
  async retrySummary(userId: string, inboxItemId: string): Promise<string> {
    if (!(await this.aiConfig.isEnabled(userId, 'summarization'))) {
      throw new BadRequestException(
        'summarization is not configured (assign a provider in Settings → AI)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to summarize');
    }
    const summary = latestOfKind(extractions, 'summary');
    if (summary && ACTIVE_STATUSES.includes(summary.status)) {
      throw new ConflictException('a summary is already being generated');
    }
    return this.enqueueSummary(inboxItemId);
  }

  /** Read model for the summary tab: latest summary + speaker roster. */
  async getSummary(userId: string, inboxItemId: string): Promise<SummaryDto> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const { speakers } = await this.context.build(item);
    const summary = latestOfKind(item.extractions ?? [], 'summary');

    if (!summary) {
      return {
        status: null,
        title: null,
        layout: null,
        markdown: null,
        offTopic: null,
        provider: null,
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
        speakers,
      };
    }

    const payload = parsePayload(summary.content);
    return {
      status: summary.status,
      title: payload?.title ?? null,
      layout: payload?.layout ?? null,
      markdown: payload?.markdown ?? null,
      offTopic: payload?.offTopic ?? null,
      provider: summary.provider,
      model: payload?.model ?? null,
      error: summary.error,
      createdAt: iso(summary.createdAt),
      completedAt: iso(summary.completedAt),
      speakers,
    };
  }

  /**
   * Best-effort regeneration of summaries for a set of items — used when a
   * change outside the extraction pipeline (e.g. redacting a speaker for
   * consent) should be reflected in the summary. No-op when summarization is
   * disabled, and never throws: a failed regeneration must not break the caller
   * (the redaction itself has already taken effect on the transcript read model).
   */
  async regenerateForItems(inboxItemIds: string[]): Promise<void> {
    for (const inboxItemId of inboxItemIds) {
      try {
        const item = await this.inbox.getItemById(inboxItemId);
        if (!item) continue;
        if (!(await this.aiConfig.isEnabled(item.userId, 'summarization'))) continue;
        const transcription = latestOfKind(item.extractions ?? [], 'transcription');
        if (transcription?.status !== 'succeeded') continue;
        const summary = latestOfKind(item.extractions ?? [], 'summary');
        if (summary && ACTIVE_STATUSES.includes(summary.status)) continue;
        await this.enqueueSummary(inboxItemId);
      } catch {
        // Best-effort: swallow so redaction still succeeds.
      }
    }
  }

  /** Append a fresh `queued` summary row and hand the job to the queue. */
  async enqueueSummary(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'summary',
      this.provider.id,
      SUMMARY_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parsePayload(content: string | null) {
  if (!content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
