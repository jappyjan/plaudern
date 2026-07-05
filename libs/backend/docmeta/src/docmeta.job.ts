import type { JobQueue } from '@plaudern/queue';

export interface DocMetaJob {
  extractionId: string;
  inboxItemId: string;
}

export const DOCMETA_QUEUE = Symbol('DOCMETA_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type DocMetaQueue = JobQueue<DocMetaJob>;
