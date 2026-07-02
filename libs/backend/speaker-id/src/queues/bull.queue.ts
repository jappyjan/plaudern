import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { DiarizationProcessor } from '../diarization.processor';
import type { DiarizationJob, DiarizationQueue } from '../diarization.job';

export const DIARIZATION_QUEUE_NAME = 'diarization';

/**
 * BullMQ-backed queue mirroring the transcription queue. Concurrency 1 because
 * the pyannote sidecar serializes inference anyway; CPU diarization is slow so
 * retries back off generously.
 */
@Injectable()
export class BullDiarizationQueue implements DiarizationQueue, OnModuleDestroy {
  private readonly logger = new Logger(BullDiarizationQueue.name);
  private readonly queue: Queue<DiarizationJob>;
  private readonly worker: Worker<DiarizationJob>;

  constructor(connection: ConnectionOptions, processor: DiarizationProcessor) {
    this.queue = new Queue(DIARIZATION_QUEUE_NAME, { connection });
    this.worker = new Worker<DiarizationJob>(
      DIARIZATION_QUEUE_NAME,
      async (job) => processor.process(job.data),
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`job ${job?.id} failed: ${err.message}`),
    );
  }

  async enqueue(job: DiarizationJob): Promise<void> {
    await this.queue.add('diarize', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
