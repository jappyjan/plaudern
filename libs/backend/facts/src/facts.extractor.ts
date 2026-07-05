import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { FactsService, FACTS_EXTRACTOR_VERSION } from './facts.service';

/**
 * Personal-fact extraction as a node of the extraction DAG (JJ-31). Depends on
 * transcription (required — there is nothing to extract facts from without a
 * transcript) and summary (settled — the summary adds density when it applies,
 * but a missing or failed summary must not block extraction: the transcript is
 * used instead). Mirrors the tasks extractor's dependency shape.
 */
@Injectable()
export class FactsExtractor implements Extractor {
  readonly kind = 'facts' as const;
  readonly version = FACTS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(private readonly facts: FactsService) {}

  enabled(): boolean {
    return this.facts.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.facts.enqueueFacts(item.id);
  }
}
