import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SummarizationService, SUMMARY_EXTRACTOR_VERSION } from './summarization.service';

/**
 * AI summary as a node of the extraction DAG. Depends on transcription
 * (required — no summary without a transcript) and diarization (settled —
 * wait for it when it applies so speakers can be attributed, but a failed
 * diarization must not block the summary). The generic pipeline evaluates
 * these edges exactly like the old bespoke SummarizationTrigger did.
 */
@Injectable()
export class SummaryExtractor implements Extractor {
  readonly kind = 'summary' as const;
  readonly version = SUMMARY_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'diarization', requires: 'settled' },
  ];

  constructor(private readonly summarization: SummarizationService) {}

  enabled(): boolean {
    return this.summarization.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.summarization.enqueueSummary(item.id);
  }
}
