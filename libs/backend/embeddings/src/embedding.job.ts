import type { JobQueue } from '@plaudern/queue';

export interface EmbeddingJob {
  extractionId: string;
  inboxItemId: string;
}

export const EMBEDDING_QUEUE = Symbol('EMBEDDING_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type EmbeddingQueue = JobQueue<EmbeddingJob>;
