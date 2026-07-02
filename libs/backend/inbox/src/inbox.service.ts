import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  ExtractionKind,
  ExtractionSegment,
  ExtractionStatus,
  SourceType,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  InboxTombstoneEntity,
  SourcePayloadEntity,
} from '@plaudern/persistence';
import { StorageService } from '@plaudern/storage';
import { InboxEventsService } from './inbox-events.service';

export interface CreatePendingItemParams {
  userId: string;
  deviceId: string | null;
  sourceType: SourceType;
  occurredAt: string;
  idempotencyKey: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  checksum?: string | null;
  originalFilename?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateCommittedItemParams extends CreatePendingItemParams {}

/**
 * Owns the inbox aggregate. Items and their payloads are never edited in
 * place — the only permitted mutations are finalizing the pending upload,
 * appending derived extractions, and deleting an item whole (rows + blobs,
 * leaving an idempotency tombstone).
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(SourcePayloadEntity)
    private readonly sources: Repository<SourcePayloadEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(InboxTombstoneEntity)
    private readonly tombstones: Repository<InboxTombstoneEntity>,
    private readonly events: InboxEventsService,
    private readonly storage: StorageService,
  ) {}

  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<InboxItemEntity | null> {
    return this.items.findOne({
      where: { userId, idempotencyKey },
      relations: { source: true },
    });
  }

  /** Create the envelope + a pending source payload (before the direct upload). */
  async createPendingItem(params: CreatePendingItemParams): Promise<InboxItemEntity> {
    const item = this.items.create({
      userId: params.userId,
      deviceId: params.deviceId,
      sourceType: params.sourceType,
      occurredAt: params.occurredAt,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata ?? null,
      source: this.sources.create({
        storageKey: params.storageKey,
        contentType: params.contentType,
        byteSize: params.byteSize,
        checksum: params.checksum ?? null,
        originalFilename: params.originalFilename ?? null,
        uploadStatus: 'pending',
      }),
    });
    return this.items.save(item);
  }

  /** Create an already-committed item (inline text or server-side stored blob). */
  async createCommittedItem(params: CreateCommittedItemParams): Promise<InboxItemEntity> {
    const item = this.items.create({
      userId: params.userId,
      deviceId: params.deviceId,
      sourceType: params.sourceType,
      occurredAt: params.occurredAt,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata ?? null,
      source: this.sources.create({
        storageKey: params.storageKey,
        contentType: params.contentType,
        byteSize: params.byteSize,
        checksum: params.checksum ?? null,
        originalFilename: params.originalFilename ?? null,
        uploadStatus: 'committed',
      }),
    });
    const saved = await this.items.save(item);
    this.events.emit({ type: 'item.created', itemId: saved.id });
    return saved;
  }

  /** Finalize the pending upload once the client's direct PUT is confirmed. */
  async markSourceCommitted(inboxItemId: string, byteSize: number): Promise<void> {
    await this.sources.update({ inboxItemId }, { uploadStatus: 'committed', byteSize });
    this.events.emit({ type: 'item.committed', itemId: inboxItemId });
  }

  /** Append a new derived-artifact row in the `queued` state. */
  async addExtraction(
    inboxItemId: string,
    kind: ExtractionKind,
    provider: string,
  ): Promise<ExtractedPayloadEntity> {
    const row = this.extractions.create({
      inboxItemId,
      kind,
      provider,
      status: 'queued',
    });
    const saved = await this.extractions.save(row);
    this.events.emit({
      type: 'extraction.updated',
      itemId: saved.inboxItemId,
      extractionId: saved.id,
      kind: saved.kind,
      status: saved.status,
    });
    return saved;
  }

  async setExtractionStatus(id: string, status: ExtractionStatus): Promise<void> {
    await this.extractions.update({ id }, { status });
    await this.emitExtractionUpdated(id, status);
  }

  async completeExtraction(
    id: string,
    result: {
      status: Extract<ExtractionStatus, 'succeeded' | 'failed'>;
      content?: string;
      segments?: ExtractionSegment[];
      language?: string;
      error?: string;
    },
  ): Promise<void> {
    await this.extractions.update(
      { id },
      {
        status: result.status,
        content: result.content ?? null,
        segments: result.segments ?? null,
        language: result.language ?? null,
        error: result.error ?? null,
        completedAt: new Date().toISOString(),
      },
    );
    await this.emitExtractionUpdated(id, result.status);
  }

  /** Callers only hold the extraction id — recover the item context for the event. */
  private async emitExtractionUpdated(id: string, status: ExtractionStatus): Promise<void> {
    const row = await this.extractions.findOne({ where: { id } });
    if (!row) return;
    this.events.emit({
      type: 'extraction.updated',
      itemId: row.inboxItemId,
      extractionId: row.id,
      kind: row.kind,
      status,
    });
  }

  async getItem(userId: string, id: string): Promise<InboxItemEntity> {
    const item = await this.items.findOne({
      where: { id, userId },
      relations: { source: true, extractions: true },
    });
    if (!item) throw new NotFoundException('inbox item not found');
    return item;
  }

  /** Whether an idempotency key belongs to a deleted item (Plaud sync skips these). */
  isIdempotencyKeyTombstoned(userId: string, idempotencyKey: string): Promise<boolean> {
    return this.tombstones.exists({ where: { userId, idempotencyKey } });
  }

  /**
   * Hard-delete an item: tombstone + rows in one transaction, then best-effort
   * blob cleanup. Blob deletion runs after the commit because S3 cannot join
   * the transaction — an orphaned blob is an invisible leak, whereas a deleted
   * blob under a still-live row would be user-visible breakage.
   */
  async deleteItem(userId: string, id: string): Promise<void> {
    const item = await this.getItem(userId, id);
    const storageKeys = [
      item.source?.storageKey,
      ...item.extractions.map((extraction) => extraction.contentStorageKey),
    ].filter((key): key is string => Boolean(key));

    // Children are deleted explicitly (instead of relying on FK cascades) so
    // the behavior is identical on Postgres and the sqlite test database.
    await this.items.manager.transaction(async (em) => {
      await em.getRepository(InboxTombstoneEntity).save({
        userId,
        idempotencyKey: item.idempotencyKey,
        deletedItemId: item.id,
        sourceType: item.sourceType,
      });
      await em.getRepository(ExtractedPayloadEntity).delete({ inboxItemId: item.id });
      await em.getRepository(SourcePayloadEntity).delete({ inboxItemId: item.id });
      await em.getRepository(InboxItemEntity).delete({ id: item.id });
    });

    this.events.emit({ type: 'item.deleted', itemId: item.id });

    const results = await Promise.allSettled(
      storageKeys.map((key) => this.storage.deleteObject(key)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(`failed to delete blob ${storageKeys[index]}: ${result.reason}`);
      }
    });
  }

  async getItemById(id: string): Promise<InboxItemEntity | null> {
    return this.items.findOne({
      where: { id },
      relations: { source: true, extractions: true },
    });
  }

  /** Keyset pagination, newest first, over (ingestedAt, id). */
  async listItems(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InboxItemEntity[]; nextCursor: string | null }> {
    const qb = this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.source', 'source')
      .leftJoinAndSelect('item.extractions', 'extractions')
      .where('item.userId = :userId', { userId })
      .orderBy('item.ingestedAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      const cursorItem = await this.items.findOne({ where: { id: cursor } });
      if (cursorItem) {
        qb.andWhere(
          '(item.ingestedAt < :ts OR (item.ingestedAt = :ts AND item.id < :id))',
          { ts: cursorItem.ingestedAt, id: cursorItem.id },
        );
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }
}
