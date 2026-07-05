import type { JobQueue } from '@plaudern/queue';

export interface TranscriptionJob {
  extractionId: string;
  inboxItemId: string;
  storageKey: string;
  contentType: string;
  filename?: string;
  languageHint?: string;
  /**
   * Text-bearing sources skip the speech provider: the processor copies the
   * stored text/plain blob into the extraction row verbatim.
   */
  passthrough?: boolean;
}

export const TRANSCRIPTION_QUEUE = Symbol('TRANSCRIPTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TranscriptionQueue = JobQueue<TranscriptionJob>;
