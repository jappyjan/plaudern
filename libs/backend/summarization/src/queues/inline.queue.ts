import { Injectable } from '@nestjs/common';
import { SummarizationProcessor } from '../summarization.processor';
import type { SummarizationJob, SummarizationQueue } from '../summarization.job';

/**
 * Runs the job synchronously in-process — no Redis. Used by tests and local dev
 * without infra. Errors are swallowed after being recorded on the extraction
 * row by the processor, so a failed summary never fails the caller.
 */
@Injectable()
export class InlineSummarizationQueue implements SummarizationQueue {
  constructor(private readonly processor: SummarizationProcessor) {}

  async enqueue(job: SummarizationJob): Promise<void> {
    try {
      await this.processor.process(job);
    } catch {
      /* status already persisted as 'failed' by the processor */
    }
  }
}
