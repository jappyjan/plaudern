import type { JobQueue } from '@plaudern/queue';

export interface EntityExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const ENTITY_EXTRACTION_QUEUE = Symbol('ENTITY_EXTRACTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type EntityExtractionQueue = JobQueue<EntityExtractionJob>;
