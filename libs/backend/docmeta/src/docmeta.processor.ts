import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { DocMetaExtractionPayload } from '@plaudern/contracts';
import { DOCMETA_PROVIDER, type DocMetaProvider } from './docmeta.provider';
import { DocMetaContextService } from './docmeta-context';
import { DocMetaPersistenceService } from './docmeta-persistence.service';
import type { DocMetaJob } from './docmeta.job';

/**
 * Executes one docmeta job (JJ-30/JJ-16): read the item's OCR text, run the LLM
 * to classify + extract fields, then persist the document, its deadline
 * reminders, and any business-card contact. When the model decides the text
 * isn't a real document it returns null and we record a succeeded (no-op)
 * extraction rather than failing.
 *
 * Depends on DocMetaPersistenceService — NOT DocMetaService — so the module
 * graph stays acyclic (mirrors the reminders/decisions processors).
 */
@Injectable()
export class DocMetaProcessor {
  private readonly logger = new Logger(DocMetaProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: DocMetaContextService,
    private readonly persistence: DocMetaPersistenceService,
    @Inject(DOCMETA_PROVIDER) private readonly provider: DocMetaProvider,
  ) {}

  async process(job: DocMetaJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = await this.context.build(item);
      if (!input) {
        throw new Error('no succeeded OCR text to extract document metadata from');
      }

      const result = await this.provider.extract(item.userId, input);
      const occurredAt = input.occurredAt ?? toIso(item.occurredAt);

      if (!result.docMeta) {
        // The model judged the text not to be a structured document — succeed
        // with an empty provenance payload rather than failing the item.
        const emptyPayload: DocMetaExtractionPayload = {
          model: result.model ?? this.provider.id,
          documentType: 'other',
          reminderCount: 0,
          contactEnriched: false,
        };
        await this.inbox.completeExtraction(job.extractionId, {
          status: 'succeeded',
          content: JSON.stringify(emptyPayload),
        });
        this.logger.log(`docmeta found no document in inbox item ${job.inboxItemId}`);
        return;
      }

      const { reminderCount, contactEnriched } = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        occurredAt,
        result.docMeta,
      );

      const payload: DocMetaExtractionPayload = {
        model: result.model ?? this.provider.id,
        documentType: result.docMeta.documentType,
        reminderCount,
        contactEnriched,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `docmeta classified inbox item ${job.inboxItemId} as ${payload.documentType} ` +
          `(${reminderCount} reminder(s), contact ${contactEnriched ? 'enriched' : 'none'})`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`docmeta extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
