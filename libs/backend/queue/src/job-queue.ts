import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

/** Abstraction over a job queue so tests run inline without Redis. */
export interface JobQueue<J> {
  enqueue(job: J): Promise<void>;
}

/** Anything that can execute one job; shared by the inline and BullMQ queues. */
export interface JobProcessor<J> {
  process(job: J): Promise<void>;
}

export interface BullJobQueueOptions {
  /** How many jobs the in-process worker runs concurrently. */
  concurrency: number;
  /** Initial delay of the exponential retry backoff. */
  backoffDelayMs: number;
}

/**
 * BullMQ-backed queue. Producer adds jobs; an in-process Worker consumes them
 * and delegates to the processor. The worker runs inside the API process; a
 * flag can split it out later.
 */
export class BullJobQueue<J> implements JobQueue<J>, OnModuleDestroy {
  private readonly logger: Logger;
  private readonly queue: Queue<J, unknown, string>;
  private readonly worker: Worker<J, unknown, string>;

  constructor(
    queueName: string,
    private readonly jobName: string,
    connection: ConnectionOptions,
    processor: JobProcessor<J>,
    private readonly options: BullJobQueueOptions,
  ) {
    this.logger = new Logger(`${BullJobQueue.name}:${queueName}`);
    this.queue = new Queue(queueName, { connection });
    this.worker = new Worker<J, unknown, string>(
      queueName,
      async (job) => processor.process(job.data),
      { connection, concurrency: options.concurrency },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`job ${job?.id} failed: ${err.message}`),
    );
  }

  async enqueue(job: J): Promise<void> {
    // `as never`: bullmq infers the name/data types via conditional types that
    // stay unresolved for a generic J; the runtime accepts any string + data.
    await this.queue.add(this.jobName as never, job as never, {
      attempts: 3,
      backoff: { type: 'exponential', delay: this.options.backoffDelayMs },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

/**
 * Runs the job synchronously in-process — no Redis. Used by tests and local dev
 * without infra. Errors are swallowed after being recorded by the processor
 * (e.g. on the extraction row), so a failed job never fails the request that
 * enqueued it.
 */
export class InlineJobQueue<J> implements JobQueue<J> {
  constructor(private readonly processor: JobProcessor<J>) {}

  async enqueue(job: J): Promise<void> {
    try {
      await this.processor.process(job);
    } catch {
      /* failure already persisted by the processor */
    }
  }
}
