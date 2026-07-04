import type { JobQueue } from '@plaudern/queue';

/**
 * One background audio-merge: concatenate the sources' blobs into the merged
 * item's `storageKey`, then stitch the derived extractions. Runs off the
 * request thread so a multi-hour re-encode never blocks (or times out) the
 * `POST /inbox/merge` call. `sourceItemIds` are already in playback order.
 */
export interface RecordingMergeJob {
  userId: string;
  mergedItemId: string;
  /** The `merge` extraction row whose status drives the progress chip. */
  mergeExtractionId: string;
  storageKey: string;
  contentType: string;
  sourceItemIds: string[];
}

export const RECORDING_MERGE_QUEUE = Symbol('RECORDING_MERGE_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type RecordingMergeQueue = JobQueue<RecordingMergeJob>;
