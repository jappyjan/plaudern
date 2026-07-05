import type { JournalPeriodType } from '@plaudern/contracts';
import type { JobQueue } from '@plaudern/queue';

/**
 * One journal composition job. Carries the pre-created `documentId` (a `queued`
 * row) so the processor writes back onto the exact version it was handed, plus
 * the period and owner it composes for.
 */
export interface JournalJob {
  documentId: string;
  userId: string;
  periodType: JournalPeriodType;
  periodKey: string;
}

export const JOURNAL_QUEUE = Symbol('JOURNAL_QUEUE');

/** Abstraction over the job queue so tests run inline without Redis. */
export type JournalQueue = JobQueue<JournalJob>;
