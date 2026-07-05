import type { JobQueue } from '@plaudern/queue';

export interface DecisionExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const DECISIONS_QUEUE = Symbol('DECISIONS_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type DecisionsQueue = JobQueue<DecisionExtractionJob>;
