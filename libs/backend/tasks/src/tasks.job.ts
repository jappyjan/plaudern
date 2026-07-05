import type { JobQueue } from '@plaudern/queue';

export interface TaskExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const TASK_EXTRACTION_QUEUE = Symbol('TASK_EXTRACTION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TaskExtractionQueue = JobQueue<TaskExtractionJob>;
