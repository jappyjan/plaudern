import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { CommitmentsService, COMMITMENTS_EXTRACTOR_VERSION } from './commitments.service';

/**
 * Commitment extraction as a node of the extraction DAG (JJ-36). Depends on
 * transcription (required — nothing to extract without a transcript) and, when
 * they apply, on diarization, summary and tasks (settled — wait so speaker
 * labels are available for direction attribution and the item's tasks exist for
 * the post-extraction task/commitment dedupe, but a missing/failed dependency
 * must not block extraction; the plain transcript is used instead, and with no
 * tasks nothing is deduped). Mirrors how the topics extractor waits on
 * `summary: settled`.
 */
@Injectable()
export class CommitmentsExtractor implements Extractor {
  readonly kind = 'commitments' as const;
  readonly version = COMMITMENTS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'diarization', requires: 'settled' },
    { kind: 'summary', requires: 'settled' },
    { kind: 'tasks', requires: 'settled' },
  ];

  constructor(private readonly commitments: CommitmentsService) {}

  enabled(userId: string): Promise<boolean> {
    return this.commitments.isEnabled(userId);
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.commitments.enqueueCommitments(item.id, item.userId);
  }
}
