import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  IngestInitRequest,
  IngestInitResponse,
  IngestTextRequest,
  InboxItemDto,
} from '@plaudern/contracts';
import type { DeviceContext } from '@plaudern/auth';
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

  async init(device: DeviceContext, req: IngestInitRequest): Promise<IngestInitResponse> {
    const adapter = this.registry.get(req.sourceType);
    adapter.validateInit(req);

    const existing = await this.inbox.findByIdempotencyKey(device.userId, req.idempotencyKey);
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
      device.userId,
      req.contentType,
      req.originalFilename,
    );
    const item = await this.inbox.createPendingItem({
      userId: device.userId,
      deviceId: device.deviceId,
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

  async commit(device: DeviceContext, inboxItemId: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(device.userId, inboxItemId);
    if (!item.source) throw new BadRequestException('item has no source payload');

    if (item.source.uploadStatus === 'committed') {
      return toInboxItemDto(item);
    }

    const head = await this.storage.headObject(item.source.storageKey);
    if (!head.exists) {
      throw new BadRequestException('uploaded object not found; PUT the file before committing');
    }

    await this.inbox.markSourceCommitted(inboxItemId, head.byteSize);

    const committed = await this.inbox.getItem(device.userId, inboxItemId);
    await this.registry.get(committed.sourceType).onCommitted(committed);

    const finalItem = await this.inbox.getItem(device.userId, inboxItemId);
    return toInboxItemDto(finalItem);
  }

  async ingestText(device: DeviceContext, req: IngestTextRequest): Promise<InboxItemDto> {
    const existing = await this.inbox.findByIdempotencyKey(device.userId, req.idempotencyKey);
    if (existing) return toInboxItemDto(await this.inbox.getItem(device.userId, existing.id));

    const storageKey = buildSourceStorageKey(device.userId, 'text/plain');
    await this.storage.putObject(storageKey, req.text, 'text/plain');

    const item = await this.inbox.createCommittedItem({
      userId: device.userId,
      deviceId: device.deviceId,
      sourceType: 'text',
      occurredAt: req.occurredAt,
      idempotencyKey: req.idempotencyKey,
      storageKey,
      contentType: 'text/plain',
      byteSize: Buffer.byteLength(req.text),
      metadata: req.metadata ?? null,
    });

    await this.registry.get('text').onCommitted(item);
    return toInboxItemDto(await this.inbox.getItem(device.userId, item.id));
  }
}
