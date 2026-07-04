export interface SummarizationJob {
  extractionId: string;
  inboxItemId: string;
}

export const SUMMARIZATION_QUEUE = Symbol('SUMMARIZATION_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export interface SummarizationQueue {
  enqueue(job: SummarizationJob): Promise<void>;
}
