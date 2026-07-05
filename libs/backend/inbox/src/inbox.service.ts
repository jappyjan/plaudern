import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  ExtractionKind,
  ExtractionSegment,
  ExtractionStatus,
  SourceType,
} from '@plaudern/contracts';
import {
  CommitmentEntity,
  EmbeddingChunkEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  InboxTombstoneEntity,
  ItemTopicEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  recomputePersonalFactSupersession,
  type PersonalFactGroupKey,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
  SourcePayloadEntity,
  SpeakerOccurrenceEntity,
  TaskCitationEntity,
  TaskEntity,
  VoiceProfileEntity,
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
    @InjectRepository(RecordingMergeEntity)
    private readonly merges: Repository<RecordingMergeEntity>,
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
    this.events.emit(saved.userId, { type: 'item.created', itemId: saved.id });
    return saved;
  }

  /** Finalize the pending upload once the client's direct PUT is confirmed. */
  async markSourceCommitted(userId: string, inboxItemId: string, byteSize: number): Promise<void> {
    await this.sources.update({ inboxItemId }, { uploadStatus: 'committed', byteSize });
    this.events.emit(userId, { type: 'item.committed', itemId: inboxItemId });
  }

  /**
   * Finalize a merged item once its background audio concatenation lands:
   * commit the (until now pending) source, record the true total duration, and
   * announce the item so clients refetch and can play the merged audio. A
   * merged item carries only the `tags.durationSeconds` metadata key, so
   * replacing metadata wholesale is safe.
   */
  async markMergedItemReady(
    userId: string,
    inboxItemId: string,
    byteSize: number,
    totalDurationSeconds: number,
  ): Promise<void> {
    await this.sources.update({ inboxItemId }, { uploadStatus: 'committed', byteSize });
    await this.items.update(
      { id: inboxItemId },
      { metadata: { tags: { durationSeconds: totalDurationSeconds } } },
    );
    this.events.emit(userId, { type: 'item.committed', itemId: inboxItemId });
  }

  /**
   * Append a new derived-artifact row in the `queued` state. `version` is the
   * extractor version (kind@version) producing the row; it defaults to 1 for
   * writers outside the extractor graph (e.g. merge stitching).
   */
  async addExtraction(
    inboxItemId: string,
    kind: ExtractionKind,
    provider: string,
    version = 1,
  ): Promise<ExtractedPayloadEntity> {
    const row = this.extractions.create({
      inboxItemId,
      kind,
      version,
      provider,
      status: 'queued',
    });
    const saved = await this.extractions.save(row);
    const ownerId = await this.ownerOf(inboxItemId);
    if (ownerId) {
      this.events.emit(ownerId, {
        type: 'extraction.updated',
        itemId: saved.inboxItemId,
        extractionId: saved.id,
        kind: saved.kind,
        status: saved.status,
      });
    }
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
    const ownerId = await this.ownerOf(row.inboxItemId);
    if (!ownerId) return;
    this.events.emit(ownerId, {
      type: 'extraction.updated',
      itemId: row.inboxItemId,
      extractionId: row.id,
      kind: row.kind,
      status,
    });
  }

  /** Owning user of an item — events must be routed to the right stream. */
  private async ownerOf(inboxItemId: string): Promise<string | null> {
    const item = await this.items.findOne({
      select: { id: true, userId: true },
      where: { id: inboxItemId },
    });
    return item?.userId ?? null;
  }

  async getItem(userId: string, id: string): Promise<InboxItemEntity> {
    const item = await this.items.findOne({
      where: { id, userId },
      relations: { source: true, extractions: true, mergeSources: true },
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
   *
   * Merge interplay: a recording hidden inside a merge cannot be deleted
   * (split first — otherwise the split would be partial). Deleting a MERGED
   * item removes its links too, so the untouched sources reappear in the
   * list; their ids are returned so callers (the split endpoint) can report
   * them.
   */
  async deleteItem(userId: string, id: string): Promise<{ restoredItemIds: string[] }> {
    const item = await this.getItem(userId, id);
    if (await this.merges.exists({ where: { sourceItemId: id } })) {
      throw new ConflictException(
        'this recording is part of a merged recording; split the merge first',
      );
    }
    const storageKeys = [
      item.source?.storageKey,
      ...item.extractions.map((extraction) => extraction.contentStorageKey),
    ].filter((key): key is string => Boolean(key));
    const restoredItemIds = (item.mergeSources ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((link) => link.sourceItemId);

    // Children are deleted explicitly (instead of relying on FK cascades) so
    // the behavior is identical on Postgres and the sqlite test database.
    await this.items.manager.transaction(async (em) => {
      await em.getRepository(InboxTombstoneEntity).save({
        userId,
        idempotencyKey: item.idempotencyKey,
        deletedItemId: item.id,
        sourceType: item.sourceType,
      });
      await em.getRepository(RecordingMergeEntity).delete({ mergedItemId: item.id });
      // Embedding chunks, entity mentions/relations and topic assignments are
      // FK children of the extractions; delete them first so behavior is
      // identical on Postgres and the sqlite test database. (Registry entities
      // are per-user, not per-item, so they survive a single-item delete and
      // are only cleared on purge.)
      await em.getRepository(EmbeddingChunkEntity).delete({ inboxItemId: item.id });
      await em.getRepository(EntityRelationEntity).delete({ inboxItemId: item.id });
      await em.getRepository(EntityMentionEntity).delete({ inboxItemId: item.id });
      await em.getRepository(ItemTopicEntity).delete({ inboxItemId: item.id });
      await em.getRepository(CommitmentEntity).delete({ inboxItemId: item.id });
      // Tasks: remember which tasks this item cited, drop the citations, then
      // hard-delete OPEN tasks left with no citations at all — an open task no
      // recording supports any more is a ghost. Completed/dismissed tasks are
      // kept: the user explicitly actioned those, that history survives the
      // recording.
      const citedTasks = await em
        .getRepository(TaskCitationEntity)
        .find({ where: { inboxItemId: item.id }, select: { taskId: true } });
      const citedTaskIds = [...new Set(citedTasks.map((c) => c.taskId))];
      await em.getRepository(TaskCitationEntity).delete({ inboxItemId: item.id });
      if (citedTaskIds.length > 0) {
        const remaining = await em
          .getRepository(TaskCitationEntity)
          .find({ where: { taskId: In(citedTaskIds) }, select: { taskId: true } });
        const stillCited = new Set(remaining.map((c) => c.taskId));
        const orphaned = citedTaskIds.filter((id) => !stillCited.has(id));
        if (orphaned.length > 0) {
          await em.getRepository(TaskEntity).delete({ id: In(orphaned), status: 'open' });
        }
      }
      // Personal facts (JJ-31): remember which (subject, attribute) groups this
      // item's facts belong to, drop the citations, hard-delete facts left with
      // no citations at all (a fact no recording supports any more is a ghost),
      // then RECOMPUTE supersession for the affected groups — so exactly one
      // exclusive fact per group re-activates (the next-newest citation-live
      // one) instead of the whole group un-pointing or staying stale.
      const citedFacts = await em
        .getRepository(PersonalFactCitationEntity)
        .find({ where: { inboxItemId: item.id }, select: { factId: true } });
      const citedFactIds = [...new Set(citedFacts.map((c) => c.factId))];
      await em.getRepository(PersonalFactCitationEntity).delete({ inboxItemId: item.id });
      if (citedFactIds.length > 0) {
        const factRows = await em
          .getRepository(PersonalFactEntity)
          .find({ where: { id: In(citedFactIds) } });
        const factGroups: PersonalFactGroupKey[] = factRows.map((f) => ({
          userId: f.userId,
          subjectKey: f.subjectKey,
          normalizedAttribute: f.normalizedAttribute,
        }));
        const remaining = await em
          .getRepository(PersonalFactCitationEntity)
          .find({ where: { factId: In(citedFactIds) }, select: { factId: true } });
        const stillCited = new Set(remaining.map((c) => c.factId));
        const orphanedFacts = citedFactIds.filter((id) => !stillCited.has(id));
        if (orphanedFacts.length > 0) {
          // Un-point pointers at the ghosts before deleting them (no FK backs
          // supersededByFactId); the recompute below re-elects the winner.
          await em
            .getRepository(PersonalFactEntity)
            .update(
              { supersededByFactId: In(orphanedFacts) },
              { supersededByFactId: null, supersededAt: null },
            );
          await em.getRepository(PersonalFactEntity).delete({ id: In(orphanedFacts) });
        }
        await recomputePersonalFactSupersession(em, factGroups);
      }
      await em.getRepository(ExtractedPayloadEntity).delete({ inboxItemId: item.id });
      await em.getRepository(SourcePayloadEntity).delete({ inboxItemId: item.id });
      await em.getRepository(InboxItemEntity).delete({ id: item.id });
    });

    this.events.emit(userId, { type: 'item.deleted', itemId: item.id });
    for (const restoredId of restoredItemIds) {
      this.events.emit(userId, { type: 'item.created', itemId: restoredId });
    }

    const results = await Promise.allSettled(
      storageKeys.map((key) => this.storage.deleteObject(key)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(`failed to delete blob ${storageKeys[index]}: ${result.reason}`);
      }
    });

    return { restoredItemIds };
  }

  /**
   * Nuke every recording and all recording-derived data for one user: inbox
   * items, source/extracted payloads, diarization occurrences, voice profiles,
   * calendar links and — crucially — the idempotency tombstones, so an
   * automated Plaud re-sync re-imports the recordings from scratch and a fresh
   * round of processing fires. Deliberately dangerous; primarily a testing aid.
   *
   * Other per-user data (Plaud credentials, calendar feeds, passkeys, sessions)
   * is left intact so the re-sync has something to sync from.
   */
  async purgeAllForUser(userId: string): Promise<{ deletedItems: number }> {
    const items = await this.items.find({
      where: { userId },
      relations: { source: true, extractions: true },
    });
    const itemIds = items.map((item) => item.id);
    const storageKeys = items
      .flatMap((item) => [
        item.source?.storageKey,
        ...item.extractions.map((extraction) => extraction.contentStorageKey),
      ])
      .filter((key): key is string => Boolean(key));

    // Explicit child deletes (rather than FK cascades) so behavior is identical
    // on Postgres and the sqlite test database — mirrors deleteItem(). Order
    // respects FK direction: occurrences/links/payloads before their parents.
    await this.items.manager.transaction(async (em) => {
      await em.getRepository(RecordingMergeEntity).delete({ userId });
      if (itemIds.length > 0) {
        await em.getRepository(SpeakerOccurrenceEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(RecordingEventLinkEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(EmbeddingChunkEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(EntityRelationEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(EntityMentionEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(ItemTopicEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(CommitmentEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(TaskCitationEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(PersonalFactCitationEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(ExtractedPayloadEntity).delete({ inboxItemId: In(itemIds) });
        await em.getRepository(SourcePayloadEntity).delete({ inboxItemId: In(itemIds) });
      }
      await em.getRepository(VoiceProfileEntity).delete({ userId });
      await em.getRepository(EntityRegistryEntity).delete({ userId });
      await em.getRepository(TaskEntity).delete({ userId });
      await em.getRepository(PersonalFactEntity).delete({ userId });
      await em.getRepository(InboxItemEntity).delete({ userId });
      await em.getRepository(InboxTombstoneEntity).delete({ userId });
    });

    for (const item of items) {
      this.events.emit(userId, { type: 'item.deleted', itemId: item.id });
    }

    const results = await Promise.allSettled(
      storageKeys.map((key) => this.storage.deleteObject(key)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(`failed to delete blob ${storageKeys[index]}: ${result.reason}`);
      }
    });

    this.logger.log(`purged ${itemIds.length} inbox items for user ${userId}`);
    return { deletedItems: itemIds.length };
  }

  async getItemById(id: string): Promise<InboxItemEntity | null> {
    return this.items.findOne({
      where: { id },
      relations: { source: true, extractions: true, mergeSources: true },
    });
  }

  /**
   * Keyset pagination, newest first, over (ingestedAt, id). Recordings that
   * were merged into another recording are hidden (not deleted) — they come
   * back the moment the merged item is split or deleted.
   */
  async listItems(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InboxItemEntity[]; nextCursor: string | null }> {
    const qb = this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.source', 'source')
      .leftJoinAndSelect('item.extractions', 'extractions')
      .leftJoinAndSelect('item.mergeSources', 'mergeSources')
      .where('item.userId = :userId', { userId })
      .andWhere((sub) => {
        const hidden = sub
          .subQuery()
          .select('1')
          .from(RecordingMergeEntity, 'rm')
          .where('rm.sourceItemId = item.id')
          .getQuery();
        return `NOT EXISTS ${hidden}`;
      })
      .orderBy('item.ingestedAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      // Scoped to the user so a foreign item id cannot serve as a probe.
      const cursorItem = await this.items.findOne({ where: { id: cursor, userId } });
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
