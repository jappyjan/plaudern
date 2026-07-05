import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionSegment, FactExtractionPayload } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import {
  FACT_EXTRACTION_PROVIDER,
  type FactExtractionProvider,
} from './facts.provider';
import { FactsRegistryService, type FactCandidate } from './facts-registry.service';
import { buildFactExtractionInput } from './fact-context';
import type { FactExtractionJob } from './facts.job';

/**
 * Executes one personal-fact extraction job (JJ-31): rebuild the extraction
 * input from the item's latest succeeded transcription/summary (plus the user's
 * known contacts as linking hints), run the LLM provider to pull durable facts
 * about people, locate each fact's source sentence in the transcript segments
 * (for a deep-linkable citation), and dedupe the candidates into the per-user
 * facts store via `FactsRegistryService` — which maintains append-only
 * supersession. The parent `facts` extraction row records provenance in
 * `content`. Shared by the inline and BullMQ queues.
 *
 * Depends on FactsRegistryService — NOT on FactsService — so the module graph
 * stays acyclic (service → queue → processor → service would deadlock Nest's
 * module compile), mirroring the tasks/commitments processors.
 */
@Injectable()
export class FactsProcessor {
  private readonly logger = new Logger(FactsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly registry: FactsRegistryService,
    @Inject(FACT_EXTRACTION_PROVIDER)
    private readonly provider: FactExtractionProvider,
  ) {}

  async process(job: FactExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const knownPeople = await this.registry.knownPeople(item.userId);
      const input = buildFactExtractionInput(item, knownPeople);
      if (!input) {
        throw new Error('no succeeded transcription or summary to extract facts from');
      }

      const result = await this.provider.extract(input);
      const segments = transcriptionSegments(item);
      const candidates: FactCandidate[] = result.facts.map((fact) => {
        const located = fact.quote ? locateQuote(segments, fact.quote) : null;
        return {
          person: fact.person,
          attribute: fact.attribute,
          value: fact.value,
          quote: fact.quote ?? null,
          startSeconds: located?.start ?? null,
        };
      });

      const factCount = await this.registry.ingest(
        item.userId,
        item.id,
        job.extractionId,
        input.occurredAt,
        candidates,
      );

      const payload: FactExtractionPayload = {
        model: result.model ?? this.provider.id,
        factCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(`extracted ${factCount} personal fact(s) from inbox item ${job.inboxItemId}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`personal-fact extraction failed for ${job.inboxItemId}: ${message}`);
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
 * matching segments, or null when the quote can't be located. Mirrors the tasks
 * processor helper.
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
