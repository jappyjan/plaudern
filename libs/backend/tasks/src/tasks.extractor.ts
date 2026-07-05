import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { TasksService, TASKS_EXTRACTOR_VERSION } from './tasks.service';

/**
 * Task extraction as a node of the extraction DAG (JJ-35). Depends on
 * transcription (required — there is nothing to extract intentions from without
 * a transcript) and summary (settled — wait for the denser summary when it
 * applies, but a missing or failed summary must not block extraction: the
 * transcript is used instead). Mirrors the topics extractor's dependency shape.
 */
@Injectable()
export class TasksExtractor implements Extractor {
  readonly kind = 'tasks' as const;
  readonly version = TASKS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(private readonly tasks: TasksService) {}

  enabled(): boolean {
    return this.tasks.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.tasks.enqueueTasks(item.id, item.userId);
  }
}
