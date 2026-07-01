import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { TranscriptionProcessor } from '../transcription.processor';
import type { TranscriptionJob, TranscriptionQueue } from '../transcription.job';

export const TRANSCRIPTION_QUEUE_NAME = 'transcription';

/**
 * BullMQ-backed queue (plan §2). Producer adds jobs; an in-process Worker
 * consumes them and delegates to the shared processor. For M1 the worker runs
 * inside the API process; a flag can split it out later.
 */
@Injectable()
export class BullTranscriptionQueue implements TranscriptionQueue, OnModuleDestroy {
  private readonly logger = new Logger(BullTranscriptionQueue.name);
  private readonly queue: Queue<TranscriptionJob>;
  private readonly worker: Worker<TranscriptionJob>;

  constructor(connection: ConnectionOptions, processor: TranscriptionProcessor) {
    this.queue = new Queue(TRANSCRIPTION_QUEUE_NAME, { connection });
    this.worker = new Worker<TranscriptionJob>(
      TRANSCRIPTION_QUEUE_NAME,
      async (job) => processor.process(job.data),
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`job ${job?.id} failed: ${err.message}`),
    );
  }

  async enqueue(job: TranscriptionJob): Promise<void> {
    await this.queue.add('transcribe', job, {
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
