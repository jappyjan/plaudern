import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  RecordingMergeEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import { StorageService } from '@plaudern/storage';
import { TranscriptionService } from '@plaudern/transcription';
import { SpeakerIdService } from '@plaudern/speaker-id';
import { AUDIO_CONCATENATOR, type AudioConcatenator } from './audio-concatenator';
import {
  stitchDiarizations,
  stitchTranscriptions,
  type MergePart,
} from './extraction-stitcher';
import type { RecordingMergeJob } from './recording-merge.job';

/**
 * Runs one audio merge off the request thread: concatenate the sources' blobs
 * into the merged item's storage key, commit the item, then stitch the derived
 * extractions. The `merge` extraction row is the progress indicator — it moves
 * queued → processing → succeeded/failed and each transition is pushed over SSE,
 * exactly like a transcription. Shared by the inline and BullMQ queues.
 *
 * Audio failures mark the merge `failed` and rethrow so BullMQ retries; the
 * (best-effort) extraction stitching is log-and-continue — once the audio is
 * ready the merge exists, and stitching problems are recoverable through the
 * ordinary retry/reprocess endpoints.
 */
@Injectable()
export class RecordingMergeProcessor {
  private readonly logger = new Logger(RecordingMergeProcessor.name);

  constructor(
    private readonly inbox: InboxService,
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

  async process(job: RecordingMergeJob): Promise<void> {
    const { userId, mergedItemId, mergeExtractionId, storageKey, contentType, sourceItemIds } = job;
    await this.inbox.setExtractionStatus(mergeExtractionId, 'processing');

    let ordered: InboxItemEntity[];
    let durationsSeconds: number[];
    try {
      // Reload the sources in playback order, with their extractions loaded for
      // stitching. getItem 404s if a source vanished (e.g. the merge was split
      // while queued) — that fails the job, which is the right signal.
      ordered = await Promise.all(sourceItemIds.map((id) => this.inbox.getItem(userId, id)));

      const result = await this.concatenator.concat(ordered.map((item) => item.source!.storageKey));
      durationsSeconds = result.durationsSeconds;

      await this.storage.putObject(storageKey, result.bytes, contentType);

      const totalDuration = durationsSeconds.reduce((sum, d) => sum + d, 0);
      await this.inbox.markMergedItemReady(userId, mergedItemId, result.bytes.byteLength, totalDuration);

      // Backfill each source's real contribution now that it's been probed.
      await Promise.all(
        durationsSeconds.map((seconds, position) =>
          this.merges.update({ mergedItemId, position }, { sourceDurationSeconds: seconds }),
        ),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`merge failed for item ${mergedItemId}: ${message}`);
      await this.inbox.completeExtraction(mergeExtractionId, { status: 'failed', error: message });
      throw err;
    }

    // From here on the merge exists; extraction problems are recoverable via
    // the ordinary retry/reprocess endpoints, so log-and-continue.
    try {
      await this.synthesizeExtractions(mergedItemId, storageKey, contentType, ordered, durationsSeconds);
    } catch (cause) {
      this.logger.error(
        `stitching extractions for merged item ${mergedItemId} failed: ${(cause as Error).message}`,
      );
    }

    await this.inbox.completeExtraction(mergeExtractionId, { status: 'succeeded' });
    this.logger.log(`merged ${ordered.length} recordings into item ${mergedItemId}`);
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

function latestOfKind(
  extractions: ExtractedPayloadEntity[] | undefined,
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return (extractions ?? [])
    .filter((e) => e.kind === kind)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
