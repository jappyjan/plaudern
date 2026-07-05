import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { hasDocumentPayload, type ItemOcrResponse } from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import { OCR_PROVIDER, type OcrProvider } from './ocr.provider';
import { OCR_QUEUE, type OcrQueue } from './ocr.job';

/**
 * Version of the OCR extractor (kind@version), recorded on every appended row.
 * Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const OCR_EXTRACTOR_VERSION = 1;

/**
 * Owns the OCR pipeline step (JJ-30). WHEN it runs is decided by the extraction
 * DAG (`OcrExtractor` — a root that applies to committed image/PDF sources).
 * This service owns enqueueing, manual retry, and the per-item read model.
 */
@Injectable()
export class OcrService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
    @Inject(OCR_QUEUE) private readonly queue: OcrQueue,
  ) {}

  /** Whether OCR is configured (a vision provider key/flag is present). */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  /** Append a fresh `queued` ocr row and hand the job to the queue. */
  async enqueueOcr(
    inboxItemId: string,
    params: { storageKey: string; contentType: string; filename?: string },
  ): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'ocr',
      this.provider.id,
      OCR_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({
      extractionId: extraction.id,
      inboxItemId,
      storageKey: params.storageKey,
      contentType: params.contentType,
      filename: params.filename,
    });
    return extraction.id;
  }

  /** Manually (re)run OCR for an item — e.g. after a failure or provider change. */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'OCR is not configured (set OCR_API_KEY, or OCR_ENABLED=true for keyless local vision endpoints)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const source = item.source;
    if (
      !source ||
      source.uploadStatus !== 'committed' ||
      !hasDocumentPayload(source.contentType)
    ) {
      throw new BadRequestException('item has no committed image/PDF source to OCR');
    }
    const latest = latestOfKind(item.extractions ?? [], 'ocr');
    if (latest && (latest.status === 'queued' || latest.status === 'processing')) {
      throw new ConflictException('OCR is already running');
    }
    return this.enqueueOcr(inboxItemId, {
      storageKey: source.storageKey,
      contentType: source.contentType,
      filename: source.originalFilename ?? undefined,
    });
  }

  /** An item's OCR read model: latest extraction's status + recognized text. */
  async getItemOcr(userId: string, inboxItemId: string): Promise<ItemOcrResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'ocr');
    return {
      status: latest?.status ?? null,
      text: latest?.content ?? null,
      language: latest?.language ?? null,
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
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
