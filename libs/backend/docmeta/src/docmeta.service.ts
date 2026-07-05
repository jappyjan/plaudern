import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  DocumentDto,
  DocumentListQuery,
  DocumentListResponse,
  ExtractionStatus,
  ItemDocMetaResponse,
} from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import {
  DocumentMetadataEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import { DOCMETA_PROVIDER, type DocMetaProvider } from './docmeta.provider';
import { DOCMETA_QUEUE, type DocMetaQueue } from './docmeta.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the docmeta extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const DOCMETA_EXTRACTOR_VERSION = 1;

/**
 * Owns the docmeta pipeline step (JJ-30/JJ-16). WHEN it runs is decided by the
 * extraction DAG (`DocMetaExtractor`, depends on `ocr`). This service owns
 * enqueueing + manual retry and the read models: an item's document, and the
 * user's vault (all documents, grouped client-side by type).
 *
 * Persisting an extraction's output lives in DocMetaPersistenceService — NOT
 * here — so the processor never needs an edge back to this service (that cycle
 * would deadlock Nest's module compile).
 */
@Injectable()
export class DocMetaService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(DOCMETA_PROVIDER) private readonly provider: DocMetaProvider,
    @Inject(DOCMETA_QUEUE) private readonly queue: DocMetaQueue,
    @InjectRepository(DocumentMetadataEntity)
    private readonly documents: Repository<DocumentMetadataEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /** Whether docmeta extraction is configured (DOCMETA_API_KEY / DOCMETA_ENABLED). */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Pipeline ----

  /** Append a fresh `queued` docmeta row and hand the job to the queue. */
  async enqueueDocMeta(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'docmeta',
      this.provider.id,
      DOCMETA_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  /** Manually (re)run docmeta for an item — e.g. after a failure or model change. */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'document-metadata extraction is not configured (set DOCMETA_API_KEY, or DOCMETA_ENABLED=true for keyless local endpoints)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const ocr = latestOfKind(extractions, 'ocr');
    if (ocr?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed OCR to extract document metadata from');
    }
    const docmeta = latestOfKind(extractions, 'docmeta');
    if (docmeta && ACTIVE_STATUSES.includes(docmeta.status)) {
      throw new ConflictException('document-metadata extraction is already running');
    }
    return this.enqueueDocMeta(inboxItemId);
  }

  // ---- Read models ----

  /** An item's document tab: latest extraction status + the structured document. */
  async getItemDocMeta(userId: string, inboxItemId: string): Promise<ItemDocMetaResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'docmeta');
    const occurredAt = iso(item.occurredAt)!;
    const row = await this.documents.findOne({ where: { userId, inboxItemId } });
    return {
      status: latest?.status ?? null,
      document: row ? toDocumentDto(row, occurredAt) : null,
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }

  /** The user's document vault: every document, newest first, optionally by type. */
  async list(userId: string, filters: DocumentListQuery): Promise<DocumentListResponse> {
    const rows = await this.documents.find({
      where: {
        userId,
        ...(filters.documentType ? { documentType: filters.documentType } : {}),
      },
      order: { createdAt: 'DESC' },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const documents = rows.map((row) =>
      toDocumentDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()),
    );
    return { documents };
  }

  /** occurredAt (ISO) per inbox item id, for building DTOs. */
  private async occurredByItem(itemIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = [...new Set(itemIds)].filter(Boolean);
    if (unique.length === 0) return map;
    const rows = await this.items.find({
      select: { id: true, occurredAt: true },
      where: { id: In(unique) },
    });
    for (const row of rows) map.set(row.id, iso(row.occurredAt)!);
    return map;
  }
}

export function toDocumentDto(row: DocumentMetadataEntity, occurredAt: string): DocumentDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    documentType: row.documentType,
    title: row.title,
    summary: row.summary,
    issuer: row.issuer,
    fields: row.fields ?? [],
    amount: row.amount,
    currency: row.currency,
    iban: row.iban,
    expiryDate: row.expiryDate,
    cancellationDate: row.cancellationDate,
    contact: row.contact,
    confidence: row.confidence,
    occurredAt,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
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
