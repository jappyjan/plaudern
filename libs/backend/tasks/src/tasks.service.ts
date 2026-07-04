import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionStatus } from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import {
  TASK_EXTRACTION_PROVIDER,
  type TaskExtractionProvider,
} from './tasks.provider';
import { TASK_EXTRACTION_QUEUE, type TaskExtractionQueue } from './tasks.job';
import { buildTaskExtractionInput } from './task-context';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the tasks extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const TASKS_EXTRACTOR_VERSION = 1;

/**
 * Owns the task-extraction pipeline step (JJ-35). WHEN it runs is decided by the
 * extraction DAG (`TasksExtractor` + the generic pipeline in
 * `@plaudern/extraction` — transcription must succeed and the summary, when it
 * applies, must settle first). This service owns HOW: enqueueing and the manual
 * retry.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(TASK_EXTRACTION_PROVIDER)
    private readonly provider: TaskExtractionProvider,
    @Inject(TASK_EXTRACTION_QUEUE)
    private readonly queue: TaskExtractionQueue,
  ) {}

  /**
   * Whether task extraction is configured (TASKS_API_KEY present, or
   * TASKS_ENABLED=true for keyless local endpoints such as Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  /**
   * Manually (re)run task extraction for an item — e.g. after a failure or a
   * provider/model change. Appends a fresh extraction (older ones stay in
   * history); the registry supersedes old citations on success.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'task extraction is not configured (set TASKS_API_KEY, or TASKS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    if (!buildTaskExtractionInput(item)) {
      throw new BadRequestException('item has no summary or transcription to extract tasks from');
    }
    const tasks = latestOfKind(item.extractions ?? [], 'tasks');
    if (tasks && ACTIVE_STATUSES.includes(tasks.status)) {
      throw new ConflictException('task extraction is already running');
    }
    return this.enqueueTasks(inboxItemId);
  }

  /** Append a fresh `queued` tasks row and hand the job to the queue. */
  async enqueueTasks(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'tasks',
      this.provider.id,
      TASKS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
