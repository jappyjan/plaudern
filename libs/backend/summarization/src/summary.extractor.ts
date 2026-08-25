import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { sourceTextDependencies, type Extractor, type ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SummarizationService, SUMMARY_EXTRACTOR_VERSION } from './summarization.service';

/**
 * AI summary as a node of the extraction DAG. Depends on source text
 * (required) and diarization (settled —
 * wait for it when it applies so speakers can be attributed, but a failed
 * diarization must not block the summary). The generic pipeline evaluates
 * these edges exactly like the old bespoke SummarizationTrigger did.
 */
@Injectable()
export class SummaryExtractor implements Extractor {
  readonly kind = 'summary' as const;
  readonly version = SUMMARY_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    ...sourceTextDependencies(),
    { kind: 'diarization', requires: 'settled' },
  ];

  constructor(
    private readonly summarization: SummarizationService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'summarization');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; source-text readiness does the real gating.
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.summarization.enqueueSummary(item.id);
  }
}
