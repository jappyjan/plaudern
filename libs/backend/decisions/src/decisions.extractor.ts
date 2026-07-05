import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { DecisionsService, DECISIONS_EXTRACTOR_VERSION } from './decisions.service';

/**
 * Decision extraction as a node of the extraction DAG (JJ-33). Depends on
 * transcription (required — nothing to extract without a transcript) and, when
 * they apply, on diarization and summary (settled — wait so speaker labels are
 * available for participant attribution, but a missing/failed diarization or
 * summary must not block extraction; the plain transcript is used instead).
 * Mirrors the questions extractor's dependency shape.
 */
@Injectable()
export class DecisionsExtractor implements Extractor {
  readonly kind = 'decisions' as const;
  readonly version = DECISIONS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'diarization', requires: 'settled' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(private readonly decisions: DecisionsService) {}

  enabled(): boolean {
    return this.decisions.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.decisions.enqueueDecisions(item.id);
  }
}
