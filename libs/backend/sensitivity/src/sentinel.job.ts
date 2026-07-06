import type { JobQueue } from '@plaudern/queue';

export interface SentinelJob {
  extractionId: string;
  inboxItemId: string;
}

export const SENTINEL_QUEUE = Symbol('SENTINEL_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type SentinelQueue = JobQueue<SentinelJob>;
