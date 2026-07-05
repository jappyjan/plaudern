import type { JobQueue } from '@plaudern/queue';

export interface OcrJob {
  extractionId: string;
  inboxItemId: string;
  storageKey: string;
  contentType: string;
  filename?: string;
}

export const OCR_QUEUE = Symbol('OCR_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type OcrQueue = JobQueue<OcrJob>;
