import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  IngestInitRequest,
  IngestInitResponse,
  IngestTextRequest,
  InboxItemDto,
  SourceType,
} from '@plaudern/contracts';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import { AdapterRegistry, SOURCE_ADAPTERS, type SourceAdapter } from './source-adapter';
import { buildSourceStorageKey } from './storage-key';

/**
 * Orchestrates the two-phase presigned ingestion (plan §2/§3):
 *   init  -> create immutable envelope + pending payload, return presigned PUT
 *   (client PUTs bytes directly to storage)
 *   commit -> verify upload, mark committed, run the adapter's onCommitted hook.
 */
@Injectable()
export class IngestionService {
  private readonly registry: AdapterRegistry;

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    @Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[],
  ) {
    this.registry = new AdapterRegistry(adapters);
  }

  async init(req: IngestInitRequest): Promise<IngestInitResponse> {
    const adapter = this.registry.get(req.sourceType);
    adapter.validateInit(req);

    const existing = await this.inbox.findByIdempotencyKey(DEFAULT_USER_ID, req.idempotencyKey);
    if (existing?.source) {
      const uploadUrl = await this.storage.createPresignedPutUrl(
        existing.source.storageKey,
        existing.source.contentType,
      );
      return {
        inboxItemId: existing.id,
        storageKey: existing.source.storageKey,
        uploadUrl,
        alreadyCommitted: existing.source.uploadStatus === 'committed',
      };
    }

    const storageKey = buildSourceStorageKey(
      DEFAULT_USER_ID,
      req.contentType,
      req.originalFilename,
    );
    const item = await this.inbox.createPendingItem({
      userId: DEFAULT_USER_ID,
      deviceId: null,
      sourceType: req.sourceType,
      occurredAt: req.occurredAt,
      idempotencyKey: req.idempotencyKey,
      storageKey,
      contentType: req.contentType,
      byteSize: req.byteSize,
      checksum: req.checksum ?? null,
      originalFilename: req.originalFilename ?? null,
      metadata: req.metadata ?? null,
    });

    const uploadUrl = await this.storage.createPresignedPutUrl(storageKey, req.contentType);
    return { inboxItemId: item.id, storageKey, uploadUrl, alreadyCommitted: false };
  }

  async commit(inboxItemId: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(DEFAULT_USER_ID, inboxItemId);
    if (!item.source) throw new BadRequestException('item has no source payload');

    if (item.source.uploadStatus === 'committed') {
      return toInboxItemDto(item);
    }

    const head = await this.storage.headObject(item.source.storageKey);
    if (!head.exists) {
      throw new BadRequestException('uploaded object not found; PUT the file before committing');
    }

    await this.inbox.markSourceCommitted(inboxItemId, head.byteSize);

    const committed = await this.inbox.getItem(DEFAULT_USER_ID, inboxItemId);
    await this.registry.get(committed.sourceType).onCommitted(committed);

    const finalItem = await this.inbox.getItem(DEFAULT_USER_ID, inboxItemId);
    return toInboxItemDto(finalItem);
  }

  /**
   * Re-run the whole processing pipeline for an already-committed item by
   * replaying its adapter's onCommitted hook (for audio: transcription +
   * diarization). Extractions are append-only, so this enqueues fresh attempts
   * and the old ones stay in history.
   */
  async reprocess(inboxItemId: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(DEFAULT_USER_ID, inboxItemId);
    if (!item.source || item.source.uploadStatus !== 'committed') {
      throw new BadRequestException('item has no committed source to reprocess');
    }
    if (item.extractions.some((e) => e.status === 'queued' || e.status === 'processing')) {
      throw new ConflictException('processing is already in progress for this item');
    }
    await this.registry.get(item.sourceType).onCommitted(item);
    return toInboxItemDto(await this.inbox.getItem(DEFAULT_USER_ID, inboxItemId));
  }

  async ingestText(req: IngestTextRequest): Promise<InboxItemDto> {
    const existing = await this.inbox.findByIdempotencyKey(DEFAULT_USER_ID, req.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(DEFAULT_USER_ID, existing.id));

    const storageKey = buildSourceStorageKey(DEFAULT_USER_ID, 'text/plain');
    await this.storage.putObject(storageKey, req.text, 'text/plain');

    const item = await this.inbox.createCommittedItem({
      userId: DEFAULT_USER_ID,
      deviceId: null,
      sourceType: 'text',
      occurredAt: req.occurredAt,
      idempotencyKey: req.idempotencyKey,
      storageKey,
      contentType: 'text/plain',
      byteSize: Buffer.byteLength(req.text),
      metadata: req.metadata ?? null,
    });

    await this.registry.get('text').onCommitted(item);
    return toInboxItemDto(await this.inbox.getItem(DEFAULT_USER_ID, item.id));
  }

  /**
   * Server-side single-shot ingestion for blobs the backend already holds
   * (e.g. recordings pulled from the Plaud cloud) — no presigned round-trip.
   */
  async ingestBlob(params: IngestBlobParams): Promise<InboxItemDto> {
    const adapter = this.registry.get(params.sourceType);

    const existing = await this.inbox.findByIdempotencyKey(DEFAULT_USER_ID, params.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(DEFAULT_USER_ID, existing.id));

    const storageKey = buildSourceStorageKey(
      DEFAULT_USER_ID,
      params.contentType,
      params.originalFilename ?? undefined,
    );
    await this.storage.putObject(storageKey, params.body, params.contentType);

    const item = await this.inbox.createCommittedItem({
      userId: DEFAULT_USER_ID,
      deviceId: null,
      sourceType: params.sourceType,
      occurredAt: params.occurredAt,
      idempotencyKey: params.idempotencyKey,
      storageKey,
      contentType: params.contentType,
      byteSize: params.body.byteLength,
      originalFilename: params.originalFilename ?? null,
      metadata: params.metadata ?? null,
    });

    await adapter.onCommitted(await this.inbox.getItem(DEFAULT_USER_ID, item.id));
    return toInboxItemDto(await this.inbox.getItem(DEFAULT_USER_ID, item.id));
  }
}

export interface IngestBlobParams {
  sourceType: SourceType;
  body: Buffer | Uint8Array;
  contentType: string;
  occurredAt: string;
  idempotencyKey: string;
  originalFilename?: string | null;
  metadata?: Record<string, unknown> | null;
}
