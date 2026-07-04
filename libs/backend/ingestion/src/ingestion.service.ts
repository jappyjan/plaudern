import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  IngestInitRequest,
  IngestInitResponse,
  IngestTextRequest,
  IngestWebRequest,
  InboxItemDto,
  SourceType,
  WebSnapshotSource,
} from '@plaudern/contracts';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import { AdapterRegistry, SOURCE_ADAPTERS, type SourceAdapter } from './source-adapter';
import { buildSourceStorageKey } from './storage-key';
import { WebPageSnapshotService } from './web/web-page-snapshot.service';

/**
 * How long a `queued`/`processing` extraction may sit before reprocess treats
 * it as orphaned (stranded by a crashed/redeployed worker) rather than
 * genuinely in flight. Healthy jobs settle well within this; anything still
 * pending past it is reclaimed so a retry can proceed instead of failing with
 * "already in progress" forever.
 */
const STALE_EXTRACTION_MS = 15 * 60 * 1000;

/**
 * Orchestrates the two-phase presigned ingestion (plan §2/§3):
 *   init  -> create immutable envelope + pending payload, return presigned PUT
 *   (client PUTs bytes directly to storage)
 *   commit -> verify upload, mark committed, run the adapter's onCommitted hook.
 *
 * Every entry point takes the acting user; items, idempotency keys and
 * storage keys are all scoped to that user.
 */
@Injectable()
export class IngestionService {
  private readonly registry: AdapterRegistry;

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    private readonly webSnapshots: WebPageSnapshotService,
    @Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[],
  ) {
    this.registry = new AdapterRegistry(adapters);
  }

  async init(userId: string, req: IngestInitRequest): Promise<IngestInitResponse> {
    const adapter = this.registry.get(req.sourceType);
    adapter.validateInit(req);

    const existing = await this.inbox.findByIdempotencyKey(userId, req.idempotencyKey);
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

    const storageKey = buildSourceStorageKey(userId, req.contentType, req.originalFilename);
    const item = await this.inbox.createPendingItem({
      userId,
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

  async commit(userId: string, inboxItemId: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    if (!item.source) throw new BadRequestException('item has no source payload');

    if (item.source.uploadStatus === 'committed') {
      return toInboxItemDto(item);
    }

    const head = await this.storage.headObject(item.source.storageKey);
    if (!head.exists) {
      throw new BadRequestException('uploaded object not found; PUT the file before committing');
    }

    await this.inbox.markSourceCommitted(userId, inboxItemId, head.byteSize);

    const committed = await this.inbox.getItem(userId, inboxItemId);
    await this.registry.get(committed.sourceType).onCommitted(committed);

    const finalItem = await this.inbox.getItem(userId, inboxItemId);
    return toInboxItemDto(finalItem);
  }

  /**
   * Re-run the whole processing pipeline for an already-committed item by
   * replaying its adapter's onCommitted hook (for audio: transcription +
   * diarization). Extractions are append-only, so this enqueues fresh attempts
   * and the old ones stay in history.
   *
   * The guard distinguishes genuinely in-flight work from orphaned rows: a
   * worker sets a row to `processing` at job start and to a terminal state in
   * its catch, so a healthy job settles quickly. A row still `queued`/
   * `processing` long after it was appended was almost certainly stranded by a
   * crashed or redeployed worker — notably BullMQ force-fails a stalled job
   * without running our processor, so the row never reaches `failed`. Refusing
   * on those would block every future retry forever (the symptom users hit as
   * "already in progress" on an item whose transcription shows "failed",
   * because a sibling diarization row is stuck). So we reclaim stale rows and
   * replay, while still refusing when work is actually in progress.
   */
  async reprocess(userId: string, inboxItemId: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    if (!item.source || item.source.uploadStatus !== 'committed') {
      throw new BadRequestException('item has no committed source to reprocess');
    }

    const pending = item.extractions.filter(
      (e) => e.status === 'queued' || e.status === 'processing',
    );
    const now = Date.now();
    const isStale = (createdAt: Date | string): boolean =>
      now - new Date(createdAt).getTime() >= STALE_EXTRACTION_MS;

    if (pending.some((e) => !isStale(e.createdAt))) {
      throw new ConflictException('processing is already in progress for this item');
    }
    for (const stale of pending) {
      await this.inbox.completeExtraction(stale.id, {
        status: 'failed',
        error: 'superseded by reprocess (stale in-flight extraction reclaimed)',
      });
    }
    await this.registry.get(item.sourceType).onCommitted(item);
    return toInboxItemDto(await this.inbox.getItem(userId, inboxItemId));
  }

  async ingestText(userId: string, req: IngestTextRequest): Promise<InboxItemDto> {
    const existing = await this.inbox.findByIdempotencyKey(userId, req.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(userId, existing.id));

    const storageKey = buildSourceStorageKey(userId, 'text/plain');
    await this.storage.putObject(storageKey, req.text, 'text/plain');

    const item = await this.inbox.createCommittedItem({
      userId,
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
    return toInboxItemDto(await this.inbox.getItem(userId, item.id));
  }

  /**
   * Web clip ingestion (`sources/web`, VISION §2): a shared URL plus optional
   * title/readable-text snapshot become an immediately-committed item whose
   * source payload is the readable-mode text (link-rot insurance). Snapshot
   * resolution order:
   *   1. client-provided text (e.g. a browser extension's readable capture),
   *   2. server-side fetch + readability extraction of the URL,
   *   3. graceful fallback: store just the URL.
   * The fetch happens at ingest time because sources are immutable — the
   * snapshot must be sealed into the payload, not appended later.
   */
  async ingestWeb(userId: string, req: IngestWebRequest): Promise<InboxItemDto> {
    const existing = await this.inbox.findByIdempotencyKey(userId, req.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(userId, existing.id));

    let title = req.title?.trim() || null;
    let snapshotText = req.text?.trim() || null;
    let snapshotSource: WebSnapshotSource = snapshotText ? 'client' : 'none';

    if (!snapshotText) {
      const extracted = await this.webSnapshots.snapshot(req.url);
      if (extracted) {
        snapshotText = extracted.text;
        snapshotSource = 'server';
        title ??= extracted.title;
      }
    }

    // The payload always exists: the snapshot when we have one, else the bare
    // URL — an item without a source blob would break the inbox invariants.
    const payloadParts = [req.url];
    if (title) payloadParts.push(title);
    if (snapshotText) payloadParts.push(snapshotText);
    const payload = payloadParts.join('\n\n');

    const storageKey = buildSourceStorageKey(userId, 'text/plain');
    await this.storage.putObject(storageKey, payload, 'text/plain');

    const baseMetadata = req.metadata ?? {};
    const baseTags = (baseMetadata.tags as Record<string, unknown> | undefined) ?? {};
    const item = await this.inbox.createCommittedItem({
      userId,
      deviceId: null,
      sourceType: 'web',
      occurredAt: req.occurredAt,
      idempotencyKey: req.idempotencyKey,
      storageKey,
      contentType: 'text/plain',
      byteSize: Buffer.byteLength(payload),
      metadata: {
        ...baseMetadata,
        url: req.url,
        web: { snapshotSource },
        tags: title ? { ...baseTags, title } : baseTags,
      },
    });

    await this.registry.get('web').onCommitted(item);
    return toInboxItemDto(await this.inbox.getItem(userId, item.id));
  }

  /**
   * Server-side single-shot ingestion for blobs the backend already holds
   * (e.g. recordings pulled from the Plaud cloud) — no presigned round-trip.
   */
  async ingestBlob(userId: string, params: IngestBlobParams): Promise<InboxItemDto> {
    const adapter = this.registry.get(params.sourceType);

    const existing = await this.inbox.findByIdempotencyKey(userId, params.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(userId, existing.id));

    const storageKey = buildSourceStorageKey(
      userId,
      params.contentType,
      params.originalFilename ?? undefined,
    );
    await this.storage.putObject(storageKey, params.body, params.contentType);

    const item = await this.inbox.createCommittedItem({
      userId,
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

    await adapter.onCommitted(await this.inbox.getItem(userId, item.id));
    return toInboxItemDto(await this.inbox.getItem(userId, item.id));
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
