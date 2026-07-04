import type { JobQueue } from '@plaudern/queue';

export interface TopicsJob {
  extractionId: string;
  inboxItemId: string;
}

export const TOPICS_QUEUE = Symbol('TOPICS_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TopicsQueue = JobQueue<TopicsJob>;
