import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboxService } from '@plaudern/inbox';
import {
  summaryPayloadSchema,
  type ExtractionStatus,
  type SummaryDto,
} from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import {
  SUMMARIZATION_PROVIDER,
  type SummarizationProvider,
} from './summarization.provider';
import { SUMMARIZATION_QUEUE, type SummarizationQueue } from './summarization.job';
import { SummaryContextService } from './summary-context.service';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Owns the summarization pipeline step. `maybeSummarize` is the readiness gate,
 * invoked whenever a transcription or diarization finishes: it enqueues a
 * summary only once both the transcript and (when applicable) the speakers are
 * ready, and never twice for the same generation. Also exposes a manual retry
 * and the read model backing the summary tab.
 */
@Injectable()
export class SummarizationService {
  /** In-process guard so two near-simultaneous completions don't double-enqueue. */
  private readonly evaluating = new Set<string>();
  private readonly speakerIdOff: boolean;

  constructor(
    config: ConfigService,
    private readonly inbox: InboxService,
    private readonly context: SummaryContextService,
    @Inject(SUMMARIZATION_PROVIDER)
    private readonly provider: SummarizationProvider,
    @Inject(SUMMARIZATION_QUEUE)
    private readonly queue: SummarizationQueue,
  ) {
    this.speakerIdOff = config.get<string>('SPEAKER_ID_PROVIDER', 'pyannote') === 'off';
  }

  /**
   * Decide whether the item is ready to summarize and, if so, enqueue it.
   * Ready = latest transcription succeeded AND diarization is not still in
   * flight (so speaker attribution is final), with no summary already covering
   * this transcription+diarization generation.
   */
  async maybeSummarize(inboxItemId: string): Promise<void> {
    if (!this.provider.enabled) return;
    if (this.evaluating.has(inboxItemId)) return;
    this.evaluating.add(inboxItemId);
    try {
      const item = await this.inbox.getItemById(inboxItemId);
      if (!item) return;
      const extractions = item.extractions ?? [];

      const transcription = latestOfKind(extractions, 'transcription');
      if (transcription?.status !== 'succeeded') return;

      const diarization = latestOfKind(extractions, 'diarization');
      if (diarization && ACTIVE_STATUSES.includes(diarization.status)) return;
      // Diarization row not created yet, but it is on its way (audio + speaker
      // id enabled): wait for it so the summary can attribute speakers.
      if (!diarization && this.expectsDiarization(item)) return;

      const summary = latestOfKind(extractions, 'summary');
      const generationTs = Math.max(
        ts(transcription.createdAt),
        diarization ? ts(diarization.createdAt) : 0,
      );
      if (
        summary &&
        ts(summary.createdAt) >= generationTs &&
        (summary.status === 'succeeded' || ACTIVE_STATUSES.includes(summary.status))
      ) {
        return; // this generation is already summarized or in progress
      }

      await this.enqueue(inboxItemId);
    } finally {
      this.evaluating.delete(inboxItemId);
    }
  }

  /**
   * Manually (re)generate the summary for an item — e.g. after a failure or to
   * get a fresh take. Appends a new summary row; older ones stay in history.
   */
  async retrySummary(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException('summarization is not configured (set SUMMARIZATION_API_KEY)');
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
    return this.enqueue(inboxItemId);
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
    if (!this.provider.enabled) return;
    for (const inboxItemId of inboxItemIds) {
      try {
        const item = await this.inbox.getItemById(inboxItemId);
        if (!item) continue;
        const transcription = latestOfKind(item.extractions ?? [], 'transcription');
        if (transcription?.status !== 'succeeded') continue;
        const summary = latestOfKind(item.extractions ?? [], 'summary');
        if (summary && ACTIVE_STATUSES.includes(summary.status)) continue;
        await this.enqueue(inboxItemId);
      } catch {
        // Best-effort: swallow so redaction still succeeds.
      }
    }
  }

  private async enqueue(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(inboxItemId, 'summary', this.provider.id);
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  /** Audio-bearing sources get diarization unless speaker id is disabled. */
  private expectsDiarization(item: InboxItemEntity): boolean {
    if (this.speakerIdOff) return false;
    return item.source?.contentType?.startsWith('audio/') ?? false;
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

function ts(value: Date | string): number {
  return new Date(value).getTime();
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
