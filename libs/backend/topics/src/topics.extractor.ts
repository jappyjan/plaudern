import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { TopicsService, TOPICS_EXTRACTOR_VERSION } from './topics.service';

/**
 * Topic/project classification as a node of the extraction DAG (JJ-18). Depends
 * on the "source text" OR-group `{transcription, ocr}` (JJ-83 — nothing to
 * classify without either a transcript or OCR text) and summary (settled — wait
 * for it when it applies so the denser summary is used as the classification
 * signal, but a missing or failed summary must not block classification: the
 * source text is classified instead). Audio items resolve to the transcript
 * exactly as before; scanned documents are classified from their OCR text. The
 * generic pipeline evaluates these edges exactly like the embedding/summary
 * extractors.
 */
@Injectable()
export class TopicsExtractor implements Extractor {
  readonly kind = 'topics' as const;
  readonly version = TOPICS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded', group: 'sourceText' },
    { kind: 'ocr', requires: 'succeeded', group: 'sourceText' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(
    private readonly topics: TopicsService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'topics');
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
