import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { RemindersService, REMINDERS_EXTRACTOR_VERSION } from './reminders.service';

/**
 * Reminder extraction as a node of the extraction DAG (JJ-25). Depends only on
 * transcription (required — nothing to extract without text). Unlike decisions,
 * it needs no speaker attribution, so it does not wait on diarization/summary.
 * Any text-bearing source (typed note, email, web snapshot) carries a
 * passthrough transcription row, so "future date in any source" is covered.
 */
@Injectable()
export class RemindersExtractor implements Extractor {
  readonly kind = 'reminders' as const;
  readonly version = REMINDERS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
  ];

  constructor(
    private readonly reminders: RemindersService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'reminders');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating.
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.reminders.enqueueReminders(item.id);
  }
}
