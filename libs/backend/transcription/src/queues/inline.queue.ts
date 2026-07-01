import { Injectable } from '@nestjs/common';
import { TranscriptionProcessor } from '../transcription.processor';
import type { TranscriptionJob, TranscriptionQueue } from '../transcription.job';

/**
 * Runs the job synchronously in-process — no Redis. Used by tests and local dev
 * without infra. Errors are swallowed after being recorded on the extraction row
 * by the processor, so a failed transcription never fails the commit request.
 */
@Injectable()
export class InlineTranscriptionQueue implements TranscriptionQueue {
  constructor(private readonly processor: TranscriptionProcessor) {}

  async enqueue(job: TranscriptionJob): Promise<void> {
    try {
      await this.processor.process(job);
    } catch {
      /* status already persisted as 'failed' by the processor */
    }
  }
}
