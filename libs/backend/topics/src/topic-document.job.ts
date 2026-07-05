import type { JobQueue } from '@plaudern/queue';

/**
 * One living-document generation job. Carries the pre-created `documentId`
 * (a `queued` row) so the processor writes back onto the exact version it was
 * handed, plus the `topicId`/`userId` it regenerates for.
 */
export interface TopicDocumentJob {
  documentId: string;
  topicId: string;
  userId: string;
}

export const TOPIC_DOCUMENT_QUEUE = Symbol('TOPIC_DOCUMENT_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TopicDocumentQueue = JobQueue<TopicDocumentJob>;
