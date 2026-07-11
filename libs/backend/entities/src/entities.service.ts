import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService, hasSucceededSourceExtraction } from '@plaudern/inbox';
import type { ExtractionStatus } from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import {
  ENTITY_EXTRACTION_PROVIDER,
  type EntityExtractionProvider,
} from './entities.provider';
import { ENTITY_EXTRACTION_QUEUE, type EntityExtractionQueue } from './entities.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the entities extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const ENTITIES_EXTRACTOR_VERSION = 1;

/**
 * Owns the entity-extraction pipeline step. WHEN it runs is decided by the
 * extraction DAG (`EntitiesExtractor` + the generic pipeline in
 * `@plaudern/extraction` — transcription must succeed first). This service
 * owns HOW: enqueueing and the manual retry.
 */
@Injectable()
export class EntitiesService {
  constructor(
    private readonly inbox: InboxService,
    private readonly aiConfig: AiConfigService,
    @Inject(ENTITY_EXTRACTION_PROVIDER)
    private readonly provider: EntityExtractionProvider,
    @Inject(ENTITY_EXTRACTION_QUEUE)
    private readonly queue: EntityExtractionQueue,
  ) {}

  /** Whether entity extraction is configured for this user. */
  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'entity_extraction');
  }

  /**
   * Manually (re)run entity extraction for an item — e.g. after a failure or a
   * provider/model change. Appends a fresh extraction (older ones stay in
   * history); the registry supersedes old mentions on success.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!(await this.aiConfig.isEnabled(userId, 'entity_extraction'))) {
      throw new BadRequestException(
        'entity extraction is not configured (assign a provider in Settings → AI)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    if (!hasSucceededSourceExtraction(item)) {
      throw new BadRequestException(
        'item has no completed transcription or OCR text to extract entities from',
      );
    }
    const entities = latestOfKind(extractions, 'entities');
    if (entities && ACTIVE_STATUSES.includes(entities.status)) {
      throw new ConflictException('entity extraction is already running');
    }
    return this.enqueueEntities(inboxItemId);
  }

  /** Append a fresh `queued` entities row and hand the job to the queue. */
  async enqueueEntities(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'entities',
      this.provider.id,
      ENTITIES_EXTRACTOR_VERSION,
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
