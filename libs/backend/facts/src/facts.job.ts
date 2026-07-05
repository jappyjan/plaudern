import type { JobQueue } from '@plaudern/queue';

export interface FactExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const FACT_EXTRACTION_QUEUE = Symbol('FACT_EXTRACTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type FactExtractionQueue = JobQueue<FactExtractionJob>;
