import { Injectable } from '@nestjs/common';
import { DiarizationProcessor } from '../diarization.processor';
import type { DiarizationJob, DiarizationQueue } from '../diarization.job';

/**
 * Runs the job synchronously in-process — no Redis. Used by tests and local dev
 * without infra. Errors are swallowed after being recorded on the extraction row
 * by the processor, so a failed diarization never fails the commit request.
 */
@Injectable()
export class InlineDiarizationQueue implements DiarizationQueue {
  constructor(private readonly processor: DiarizationProcessor) {}

  async enqueue(job: DiarizationJob): Promise<void> {
    try {
      await this.processor.process(job);
    } catch {
      /* status already persisted as 'failed' by the processor */
    }
  }
}
