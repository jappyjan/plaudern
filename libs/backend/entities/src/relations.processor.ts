import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { RelationExtractionPayload } from '@plaudern/contracts';
import {
  RELATION_EXTRACTION_PROVIDER,
  type RelationExtractionProvider,
} from './relations.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityContactResolverService } from './entity-contact-resolver.service';
import { EntityGraphService } from './entity-graph.service';
import { buildRelationExtractionInput } from './relation-context';
import type { RelationExtractionJob } from './relations.job';

/**
 * Executes one relation-extraction job: look up the entities the item's
 * latest `entities` extraction linked, run the LLM provider over the
 * transcript with those entities as the only legal endpoints, and persist the
 * validated edges (plus implicit co-occurrence) into `entity_relations`. The
 * parent `relations` extraction row records provenance in `content`. Shared
 * by the inline and BullMQ queues.
 */
@Injectable()
export class RelationsProcessor {
  private readonly logger = new Logger(RelationsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
    private readonly resolver: EntityContactResolverService,
    @Inject(RELATION_EXTRACTION_PROVIDER)
    private readonly provider: RelationExtractionProvider,
  ) {}

  async process(job: RelationExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const entities = await this.registry.entitiesForItem(item.userId, item.id);
      const input = buildRelationExtractionInput(item, entities);
      if (!input) {
        throw new Error('no succeeded transcription to extract relations from');
      }

      // Fewer than two entities means no possible edge — succeed with zero
      // relations without spending an LLM call.
      let relationCount = 0;
      let model = this.provider.id;
      if (entities.length >= 2) {
        const result = await this.provider.extract(input);
        model = result.model ?? this.provider.id;
        relationCount = await this.graph.ingest(
          item.userId,
          item.id,
          job.extractionId,
          result.relations,
          entities,
        );
      }

      const payload: RelationExtractionPayload = { model, relationCount };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${relationCount} relations from inbox item ${job.inboxItemId}`,
      );

      // The graph just gained this item's edges — re-run contact resolution
      // for its person entities with the richer evidence (shared neighbors,
      // co-mentions). Enrichment only — never fails the extraction.
      await this.resolver
        .autoLinkForItem(item.userId, item.id)
        .catch((err) =>
          this.logger.warn(`contact resolution after relations failed: ${(err as Error).message}`),
        );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`relation extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}
