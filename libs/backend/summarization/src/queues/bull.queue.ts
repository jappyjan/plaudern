import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { SummarizationProcessor } from '../summarization.processor';
import type { SummarizationJob, SummarizationQueue } from '../summarization.job';

export const SUMMARIZATION_QUEUE_NAME = 'summarization';

/**
 * BullMQ-backed queue. Producer adds jobs; an in-process Worker consumes them
 * and delegates to the shared processor. Mirrors the transcription/diarization
 * queues so summarization is just another async pipeline step.
 */
@Injectable()
export class BullSummarizationQueue implements SummarizationQueue, OnModuleDestroy {
  private readonly logger = new Logger(BullSummarizationQueue.name);
  private readonly queue: Queue<SummarizationJob>;
  private readonly worker: Worker<SummarizationJob>;

  constructor(connection: ConnectionOptions, processor: SummarizationProcessor) {
    this.queue = new Queue(SUMMARIZATION_QUEUE_NAME, { connection });
    this.worker = new Worker<SummarizationJob>(
      SUMMARIZATION_QUEUE_NAME,
      async (job) => processor.process(job.data),
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`job ${job?.id} failed: ${err.message}`),
    );
  }

  async enqueue(job: SummarizationJob): Promise<void> {
    await this.queue.add('summarize', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
