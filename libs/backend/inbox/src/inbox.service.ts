import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ExtractionKind, ExtractionStatus, SourceType } from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SourcePayloadEntity,
} from '@plaudern/persistence';

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
 * Owns the immutable inbox aggregate. There is intentionally no method to edit
 * or delete an item or its source payload — the only permitted mutations are
 * finalizing the pending upload and appending derived extractions (plan §2).
 */
@Injectable()
export class InboxService {
  constructor(
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(SourcePayloadEntity)
    private readonly sources: Repository<SourcePayloadEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
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
    return this.items.save(item);
  }

  /** Finalize the pending upload once the client's direct PUT is confirmed. */
  async markSourceCommitted(inboxItemId: string, byteSize: number): Promise<void> {
    await this.sources.update({ inboxItemId }, { uploadStatus: 'committed', byteSize });
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
    return this.extractions.save(row);
  }

  async setExtractionStatus(id: string, status: ExtractionStatus): Promise<void> {
    await this.extractions.update({ id }, { status });
  }

  async completeExtraction(
    id: string,
    result: { status: Extract<ExtractionStatus, 'succeeded' | 'failed'>; content?: string; language?: string; error?: string },
  ): Promise<void> {
    await this.extractions.update(
      { id },
      {
        status: result.status,
        content: result.content ?? null,
        language: result.language ?? null,
        error: result.error ?? null,
        completedAt: new Date().toISOString(),
      },
    );
  }

  async getItem(userId: string, id: string): Promise<InboxItemEntity> {
    const item = await this.items.findOne({
      where: { id, userId },
      relations: { source: true, extractions: true },
    });
    if (!item) throw new NotFoundException('inbox item not found');
    return item;
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
