import type { JobQueue } from '@plaudern/queue';

export interface RelationExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const RELATION_EXTRACTION_QUEUE = Symbol('RELATION_EXTRACTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type RelationExtractionQueue = JobQueue<RelationExtractionJob>;
