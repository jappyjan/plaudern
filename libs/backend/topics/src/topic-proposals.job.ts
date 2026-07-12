import type { JobQueue } from '@plaudern/queue';

/**
 * One taxonomy-proposal generation run (JJ-69). Carries only the `userId`: the
 * run row is keyed one-per-user and already claimed (`queued`) by the service
 * before enqueue, so the processor loads and flips it by `userId`.
 */
export interface TopicProposalGenerationJob {
  userId: string;
}

export const TOPIC_PROPOSAL_GENERATION_QUEUE = Symbol('TOPIC_PROPOSAL_GENERATION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type TopicProposalGenerationQueue = JobQueue<TopicProposalGenerationJob>;
