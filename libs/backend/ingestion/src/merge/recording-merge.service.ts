import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { InboxItemDto, InboxSplitResponse } from '@plaudern/contracts';
import { InboxEventsService, InboxService, toInboxItemDto } from '@plaudern/inbox';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  RecordingMergeEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import { StorageService } from '@plaudern/storage';
import { TranscriptionService } from '@plaudern/transcription';
import { SpeakerIdService } from '@plaudern/speaker-id';
import { buildSourceStorageKey } from '../storage-key';
import { AUDIO_CONCATENATOR, type AudioConcatenator } from './audio-concatenator';
import {
  stitchDiarizations,
  stitchTranscriptions,
  type MergePart,
} from './extraction-stitcher';

/**
 * Combines several recordings into one — and splits them apart again.
 *
 * Merge honors the inbox's immutability: it creates a NEW item with the
 * concatenated audio and hides (never touches) the sources behind
 * recording_merges link rows. Transcription and diarization are NOT re-run:
 * the per-part results are stitched together with time offsets (transcribing
 * the parts separately yields the same text as the whole), and only the
 * downstream summarization re-fires — automatically, via the extraction
 * events the synthesized rows emit. Split deletes the merged item and its
 * links; the untouched sources simply reappear.
 */
@Injectable()
export class RecordingMergeService {
  private readonly logger = new Logger(RecordingMergeService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly events: InboxEventsService,
    private readonly storage: StorageService,
    private readonly transcription: TranscriptionService,
    private readonly speakerId: SpeakerIdService,
    @Inject(AUDIO_CONCATENATOR)
    private readonly concatenator: AudioConcatenator,
    @InjectRepository(RecordingMergeEntity)
    private readonly merges: Repository<RecordingMergeEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
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

    const { bytes, contentType, durationsSeconds } = await this.concatenator.concat(
      ordered.map((item) => item.source!.storageKey),
    );

    const storageKey = buildSourceStorageKey(userId, contentType);
    await this.storage.putObject(storageKey, bytes, contentType);

    let merged: InboxItemEntity;
    try {
      merged = await this.inbox.createCommittedItem({
        userId,
        deviceId: null,
        sourceType: 'audio',
        occurredAt: ordered[0].occurredAt,
        idempotencyKey: `merge:${randomUUID()}`,
        storageKey,
        contentType,
        byteSize: bytes.byteLength,
        metadata: {
          tags: { durationSeconds: durationsSeconds.reduce((sum, d) => sum + d, 0) },
        },
      });
    } catch (cause) {
      await this.storage.deleteObject(storageKey).catch(() => undefined);
      throw cause;
    }

    try {
      // One save call = one transaction. The unique index on sourceItemId is
      // the concurrency guard: two racing merges sharing a source cannot both
      // insert their links.
      await this.merges.save(
        ordered.map((item, position) =>
          this.merges.create({
            userId,
            mergedItemId: merged.id,
            sourceItemId: item.id,
            position,
            sourceDurationSeconds: durationsSeconds[position],
          }),
        ),
      );
    } catch (cause) {
      // Compensate: remove the freshly created merged item (rows + blob).
      await this.inbox.deleteItem(userId, merged.id).catch(() => undefined);
      throw new ConflictException('a selected recording was just merged elsewhere; try again');
    }

    for (const item of ordered) {
      this.events.emit(userId, { type: 'item.deleted', itemId: item.id });
    }

    // From here on the merge exists; extraction problems are recoverable via
    // the ordinary retry/reprocess endpoints, so log-and-continue.
    try {
      await this.synthesizeExtractions(merged.id, storageKey, contentType, ordered, durationsSeconds);
    } catch (cause) {
      this.logger.error(
        `stitching extractions for merged item ${merged.id} failed: ${(cause as Error).message}`,
      );
    }

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

  /**
   * Stitch the sources' transcription/diarization results onto the merged
   * timeline instead of re-running the hosted APIs. A kind is synthesized
   * only when EVERY part has a succeeded result of it; otherwise the real
   * stage runs against the merged audio. Both rows are appended in `queued`
   * state before either completes, so the summarization readiness gate sees
   * the in-flight sibling and the (single) summary fires on the last
   * completion.
   */
  private async synthesizeExtractions(
    mergedItemId: string,
    storageKey: string,
    contentType: string,
    ordered: InboxItemEntity[],
    durationsSeconds: number[],
  ): Promise<void> {
    const offsets = durationsSeconds.map((_, i) =>
      durationsSeconds.slice(0, i).reduce((sum, d) => sum + d, 0),
    );

    const transcriptions = ordered.map((item) => latestOfKind(item.extractions, 'transcription'));
    const diarizations = ordered.map((item) => latestOfKind(item.extractions, 'diarization'));

    const canStitchTranscription = transcriptions.every(
      (row) => row?.status === 'succeeded' && row.content !== null,
    );
    const canStitchDiarization = diarizations.every(
      (row) => row?.status === 'succeeded' && (row.segments?.length ?? 0) > 0,
    );

    const parts: MergePart[] = await Promise.all(
      ordered.map(async (item, i) => ({
        itemId: item.id,
        offsetSeconds: offsets[i],
        transcription: transcriptions[i]
          ? {
              content: transcriptions[i]!.content,
              segments: transcriptions[i]!.segments ?? null,
              language: transcriptions[i]!.language,
            }
          : undefined,
        diarization: diarizations[i] ? { segments: diarizations[i]!.segments ?? null } : undefined,
        occurrences: diarizations[i]
          ? await this.occurrences.find({
              select: { label: true, voiceProfileId: true },
              where: { extractionId: diarizations[i]!.id },
            })
          : [],
      })),
    );

    // Append both queued rows first (summarization gate), then complete.
    const transcriptionRow = canStitchTranscription
      ? await this.inbox.addExtraction(mergedItemId, 'transcription', 'merged')
      : null;
    const diarizationRow = canStitchDiarization
      ? await this.inbox.addExtraction(mergedItemId, 'diarization', 'merged')
      : null;

    if (diarizationRow) {
      const { segments, occurrences } = stitchDiarizations(parts);
      await this.occurrences.save(
        occurrences.map((occurrence) =>
          this.occurrences.create({
            inboxItemId: mergedItemId,
            extractionId: diarizationRow.id,
            voiceProfileId: occurrence.voiceProfileId,
            label: occurrence.label,
            speakingSeconds: occurrence.speakingSeconds,
            similarity: null,
          }),
        ),
      );
      await this.inbox.completeExtraction(diarizationRow.id, { status: 'succeeded', segments });
    } else {
      // No-op (returns null) when speaker identification is turned off —
      // matching how the sources were processed.
      await this.speakerId.enqueueDiarization(mergedItemId, { storageKey, contentType });
    }

    if (transcriptionRow) {
      const { content, segments, language } = stitchTranscriptions(parts);
      await this.inbox.completeExtraction(transcriptionRow.id, {
        status: 'succeeded',
        content,
        segments,
        language: language ?? undefined,
      });
    } else {
      await this.transcription.enqueueTranscription(mergedItemId, { storageKey, contentType });
    }
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

function latestOfKind(
  extractions: ExtractedPayloadEntity[] | undefined,
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return (extractions ?? [])
    .filter((e) => e.kind === kind)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
