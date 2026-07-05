import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionStatus } from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import {
  RELATION_EXTRACTION_PROVIDER,
  type RelationExtractionProvider,
} from './relations.provider';
import { RELATION_EXTRACTION_QUEUE, type RelationExtractionQueue } from './relations.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the relations extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves (better model or
 * prompt) so backfill runs can catch older items up.
 */
export const RELATIONS_EXTRACTOR_VERSION = 1;

/**
 * Owns the relation-extraction pipeline step. WHEN it runs is decided by the
 * extraction DAG (`RelationsExtractor` + the generic pipeline in
 * `@plaudern/extraction` — the `entities` extraction must succeed first).
 * This service owns HOW: enqueueing and the manual retry.
 */
@Injectable()
export class RelationsService {
  constructor(
    private readonly inbox: InboxService,
    private readonly aiConfig: AiConfigService,
    @Inject(RELATION_EXTRACTION_PROVIDER)
    private readonly provider: RelationExtractionProvider,
    @Inject(RELATION_EXTRACTION_QUEUE)
    private readonly queue: RelationExtractionQueue,
  ) {}

  /** Whether relation extraction is configured for this user. */
  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'entity_relations');
  }

  /**
   * Manually (re)run relation extraction for an item — e.g. after a failure or
   * a provider/model change. Appends a fresh extraction (older ones stay in
   * history); the graph supersedes old evidence on success.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!(await this.aiConfig.isEnabled(userId, 'entity_relations'))) {
      throw new BadRequestException(
        'relation extraction is not configured (assign a provider in Settings → AI)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const entities = latestOfKind(extractions, 'entities');
    if (entities?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed entity extraction to relate');
    }
    const relations = latestOfKind(extractions, 'relations');
    if (relations && ACTIVE_STATUSES.includes(relations.status)) {
      throw new ConflictException('relation extraction is already running');
    }
    return this.enqueueRelations(inboxItemId);
  }

  /** Append a fresh `queued` relations row and hand the job to the queue. */
  async enqueueRelations(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'relations',
      this.provider.id,
      RELATIONS_EXTRACTOR_VERSION,
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
