import type { JobQueue } from '@plaudern/queue';

export interface CommitmentExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const COMMITMENTS_QUEUE = Symbol('COMMITMENTS_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type CommitmentsQueue = JobQueue<CommitmentExtractionJob>;
