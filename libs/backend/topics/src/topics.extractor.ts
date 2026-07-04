import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { TopicsService, TOPICS_EXTRACTOR_VERSION } from './topics.service';

/**
 * Topic/project classification as a node of the extraction DAG (JJ-18). Depends
 * on transcription (required — nothing to classify without a transcript) and
 * summary (settled — wait for it when it applies so the denser summary is used
 * as the classification signal, but a missing or failed summary must not block
 * classification: the transcript is classified instead). The generic pipeline
 * evaluates these edges exactly like the embedding/summary extractors.
 */
@Injectable()
export class TopicsExtractor implements Extractor {
  readonly kind = 'topics' as const;
  readonly version = TOPICS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(private readonly topics: TopicsService) {}

  enabled(): boolean {
    return this.topics.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.topics.enqueueTopics(item.id);
  }
}
