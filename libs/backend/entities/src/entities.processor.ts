import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { EntityExtractionPayload } from '@plaudern/contracts';
import {
  ENTITY_EXTRACTION_PROVIDER,
  type EntityExtractionProvider,
} from './entities.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityContactResolverService } from './entity-contact-resolver.service';
import { buildEntityExtractionInput } from './entity-context';
import type { EntityExtractionJob } from './entities.job';

/**
 * Executes one entity-extraction job: rebuild the extraction input from the
 * item's latest succeeded transcription, run the LLM provider, and normalize
 * the results into the per-user registry (`entities` + `entity_mentions`). The
 * parent `entities` extraction row records provenance in `content`. Shared by
 * the inline and BullMQ queues.
 */
@Injectable()
export class EntitiesProcessor {
  private readonly logger = new Logger(EntitiesProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly registry: EntitiesRegistryService,
    private readonly resolver: EntityContactResolverService,
    @Inject(ENTITY_EXTRACTION_PROVIDER)
    private readonly provider: EntityExtractionProvider,
  ) {}

  async process(job: EntityExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = buildEntityExtractionInput(item);
      if (!input) {
        throw new Error('no succeeded transcription to extract entities from');
      }

      const result = await this.provider.extract(input);
      const entityCount = await this.registry.ingest(
        item.userId,
        item.id,
        job.extractionId,
        result.entities,
      );

      const payload: EntityExtractionPayload = {
        model: result.model ?? this.provider.id,
        entityCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(`extracted ${entityCount} entities from inbox item ${job.inboxItemId}`);

      // First contact-resolution pass with the evidence available now (names +
      // whose voice is in the recording); the relations processor re-runs it
      // once this item's graph edges exist. Enrichment only — never fails the
      // extraction.
      await this.resolver
        .autoLinkForItem(item.userId, item.id)
        .catch((err) =>
          this.logger.warn(`contact resolution after extraction failed: ${(err as Error).message}`),
        );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`entity extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}
