import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { CommitmentsService, COMMITMENTS_EXTRACTOR_VERSION } from './commitments.service';

/**
 * Commitment extraction as a node of the extraction DAG (JJ-36). Depends on
 * transcription (required — nothing to extract without a transcript) and, when
 * they apply, on diarization and summary (settled — wait so speaker labels are
 * available for direction attribution, but a missing/failed diarization or
 * summary must not block extraction; the plain transcript is used instead).
 * Mirrors how the topics extractor waits on `summary: settled`.
 */
@Injectable()
export class CommitmentsExtractor implements Extractor {
  readonly kind = 'commitments' as const;
  readonly version = COMMITMENTS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'diarization', requires: 'settled' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(private readonly commitments: CommitmentsService) {}

  enabled(): boolean {
    return this.commitments.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.commitments.enqueueCommitments(item.id);
  }
}
