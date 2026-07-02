export interface DiarizationJob {
  extractionId: string;
  inboxItemId: string;
  storageKey: string;
  contentType: string;
}

export const DIARIZATION_QUEUE = Symbol('DIARIZATION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export interface DiarizationQueue {
  enqueue(job: DiarizationJob): Promise<void>;
}
