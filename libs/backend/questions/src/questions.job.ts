import type { JobQueue } from '@plaudern/queue';

export interface QuestionExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const QUESTIONS_QUEUE = Symbol('QUESTIONS_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type QuestionsQueue = JobQueue<QuestionExtractionJob>;
