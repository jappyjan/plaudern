import type { JobQueue } from '@plaudern/queue';

/**
 * One taxonomy-proposal generation run (JJ-69). `generationId` is renewed on
 * every admission so delayed jobs and stale workers cannot claim or write for a
 * newer run belonging to the same user.
 */
export interface TopicProposalGenerationJob {
  userId: string;
  /** Optional only for durable jobs enqueued before generation ownership shipped. */
  generationId?: string;
}

export const TOPIC_PROPOSAL_GENERATION_QUEUE = Symbol('TOPIC_PROPOSAL_GENERATION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TopicProposalGenerationQueue = JobQueue<TopicProposalGenerationJob>;
