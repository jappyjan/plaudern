import type { JobQueue } from '@plaudern/queue';

export interface ReminderExtractionJob {
  extractionId: string;
  inboxItemId: string;
}

export const REMINDERS_QUEUE = Symbol('REMINDERS_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type RemindersQueue = JobQueue<ReminderExtractionJob>;
