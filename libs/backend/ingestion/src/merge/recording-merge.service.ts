import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { InboxItemDto, InboxSplitResponse } from '@plaudern/contracts';
import { InboxEventsService, InboxService, toInboxItemDto } from '@plaudern/inbox';
import { InboxItemEntity, RecordingMergeEntity } from '@plaudern/persistence';
import { buildSourceStorageKey } from '../storage-key';
import { RECORDING_MERGE_QUEUE, type RecordingMergeQueue } from './recording-merge.job';

/** The merged audio is always re-encoded to a single mp3 by the concatenator. */
const MERGED_CONTENT_TYPE = 'audio/mpeg';

/**
 * Combines several recordings into one — and splits them apart again.
 *
 * Merge honors the inbox's immutability: it creates a NEW item with the
 * concatenated audio and hides (never touches) the sources behind
 * recording_merges link rows. The actual audio concatenation is a re-encoding
 * ffmpeg pass that can take minutes for long recordings, so it runs off the
 * request thread in a background job (RecordingMergeProcessor): this endpoint
 * returns immediately with a pending merged item whose `merge` extraction is
 * the progress indicator the UI renders (queued → processing → succeeded).
 * Transcription and diarization are NOT re-run — the job stitches the per-part
 * results together with time offsets. Split deletes the merged item and its
 * links; the untouched sources simply reappear.
 */
@Injectable()
export class RecordingMergeService {
  constructor(
    private readonly inbox: InboxService,
    private readonly events: InboxEventsService,
    @Inject(RECORDING_MERGE_QUEUE)
    private readonly queue: RecordingMergeQueue,
    @InjectRepository(RecordingMergeEntity)
    private readonly merges: Repository<RecordingMergeEntity>,
  ) {}

  async merge(userId: string, itemIds: string[]): Promise<InboxItemDto> {
    const distinct = [...new Set(itemIds)];
    if (distinct.length < 2) {
      throw new BadRequestException('merging needs at least two distinct recordings');
    }

    // getItem throws 404 for unknown/foreign ids — the ownership check.
    const items = await Promise.all(distinct.map((id) => this.inbox.getItem(userId, id)));
    for (const item of items) {
      if (!item.source || item.source.uploadStatus !== 'committed') {
        throw new BadRequestException(`recording ${item.id} has no committed audio`);
      }
      if (!item.source.contentType.startsWith('audio/')) {
        throw new BadRequestException(`item ${item.id} is not an audio recording`);
      }
    }
    if (await this.merges.exists({ where: { sourceItemId: In(distinct) } })) {
      throw new ConflictException('a selected recording is already part of a merged recording');
    }

    // Playback order is chronological, regardless of the order requested.
    const ordered = items.slice().sort(byCaptureTime);

    // Reserve the merged blob's key now so the item can exist before the (slow)
    // concatenation runs. The background job writes to this key and commits.
    const storageKey = buildSourceStorageKey(userId, MERGED_CONTENT_TYPE);

    // Create the merged item immediately with a PENDING source — returning
    // before the audio is assembled is what makes merge feel instant. The
    // duration is a placeholder until the job probes the real parts.
    const merged = await this.inbox.createPendingItem({
      userId,
      deviceId: null,
      sourceType: 'audio',
      occurredAt: ordered[0].occurredAt,
      idempotencyKey: `merge:${randomUUID()}`,
      storageKey,
      contentType: MERGED_CONTENT_TYPE,
      byteSize: 0,
      metadata: { tags: { durationSeconds: 0 } },
    });

    try {
      // One save call = one transaction. The unique index on sourceItemId is
      // the concurrency guard: two racing merges sharing a source cannot both
      // insert their links. Claiming the sources here also hides them from the
      // list. Real per-part durations are backfilled by the job once probed.
      await this.merges.save(
        ordered.map((item, position) =>
          this.merges.create({
            userId,
            mergedItemId: merged.id,
            sourceItemId: item.id,
            position,
            sourceDurationSeconds: 0,
          }),
        ),
      );
    } catch (cause) {
      // Compensate: remove the freshly created merged item (rows + pending blob).
      await this.inbox.deleteItem(userId, merged.id).catch(() => undefined);
      throw new ConflictException('a selected recording was just merged elsewhere; try again');
    }

    // The `merge` extraction is the progress indicator the UI renders while the
    // audio concatenation runs; addExtraction emits the SSE event that surfaces
    // the new merged item (in its pending state) to connected clients.
    const mergeExtraction = await this.inbox.addExtraction(merged.id, 'merge', 'ffmpeg');
    this.events.emit(userId, { type: 'item.created', itemId: merged.id });

    for (const item of ordered) {
      this.events.emit(userId, { type: 'item.deleted', itemId: item.id });
    }

    await this.queue.enqueue({
      userId,
      mergedItemId: merged.id,
      mergeExtractionId: mergeExtraction.id,
      storageKey,
      contentType: MERGED_CONTENT_TYPE,
      sourceItemIds: ordered.map((item) => item.id),
    });

    // Bull: the pending item with a queued `merge` chip. Inline (tests/dev): the
    // job already ran synchronously, so this reflects the finished merge.
    return toInboxItemDto(await this.inbox.getItem(userId, merged.id));
  }

  /**
   * Split a merged recording back into its parts: delete the merged item and
   * its link rows — the untouched sources reappear in the inbox.
   */
  async split(userId: string, mergedItemId: string): Promise<InboxSplitResponse> {
    await this.inbox.getItem(userId, mergedItemId); // 404 on unknown/foreign
    const links = await this.merges.find({
      where: { mergedItemId },
      order: { position: 'ASC' },
    });
    if (links.length === 0) {
      throw new BadRequestException('this recording was not produced by a merge');
    }
    const { restoredItemIds } = await this.inbox.deleteItem(userId, mergedItemId);
    return { restoredItemIds };
  }
}

/** Chronological capture order with stable tie-breaks. */
function byCaptureTime(a: InboxItemEntity, b: InboxItemEntity): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  const aIngested = new Date(a.ingestedAt).getTime();
  const bIngested = new Date(b.ingestedAt).getTime();
  if (aIngested !== bIngested) return aIngested - bIngested;
  return a.id < b.id ? -1 : 1;
}
