import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionStatus } from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import {
  FACT_EXTRACTION_PROVIDER,
  type FactExtractionProvider,
} from './facts.provider';
import { FACT_EXTRACTION_QUEUE, type FactExtractionQueue } from './facts.job';
import { buildFactExtractionInput } from './fact-context';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the facts extractor (kind@version), recorded on every appended row.
 * Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const FACTS_EXTRACTOR_VERSION = 1;

/**
 * Owns the personal-fact extraction pipeline step (JJ-31). WHEN it runs is
 * decided by the extraction DAG (`FactsExtractor` + the generic pipeline in
 * `@plaudern/extraction` — transcription must succeed and the summary, when it
 * applies, must settle first). This service owns HOW: enqueueing and the manual
 * retry. Persisting an extraction's output lives in FactsRegistryService —
 * deliberately NOT here, so the processor (reached via the queue this service
 * injects) never needs an edge back to this service; that cycle would deadlock
 * Nest's module compile.
 */
@Injectable()
export class FactsService {
  constructor(
    private readonly inbox: InboxService,
    private readonly aiConfig: AiConfigService,
    @Inject(FACT_EXTRACTION_PROVIDER)
    private readonly provider: FactExtractionProvider,
    @Inject(FACT_EXTRACTION_QUEUE)
    private readonly queue: FactExtractionQueue,
  ) {}

  /** Whether personal-fact extraction is configured for this user. */
  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'facts');
  }

  /**
   * Manually (re)run personal-fact extraction for an item — e.g. after a failure
   * or a provider/model change. Appends a fresh extraction (older ones stay in
   * history); the registry supersedes old citations on success.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!(await this.aiConfig.isEnabled(userId, 'facts'))) {
      throw new BadRequestException(
        'personal-fact extraction is not configured — assign a provider to the facts capability in Settings → AI',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    if (!buildFactExtractionInput(item)) {
      throw new BadRequestException('item has no summary or transcription to extract facts from');
    }
    const facts = latestOfKind(item.extractions ?? [], 'facts');
    if (facts && ACTIVE_STATUSES.includes(facts.status)) {
      throw new ConflictException('personal-fact extraction is already running');
    }
    return this.enqueueFacts(inboxItemId);
  }

  /** Append a fresh `queued` facts row and hand the job to the queue. */
  async enqueueFacts(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'facts',
      this.provider.id,
      FACTS_EXTRACTOR_VERSION,
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
