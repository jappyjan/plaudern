import type { JobQueue } from '@plaudern/queue';

export interface TranscriptionJob {
  extractionId: string;
  inboxItemId: string;
  storageKey: string;
  contentType: string;
  filename?: string;
  languageHint?: string;
}

export const TRANSCRIPTION_QUEUE = Symbol('TRANSCRIPTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TranscriptionQueue = JobQueue<TranscriptionJob>;
