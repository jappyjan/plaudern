import { Injectable } from '@nestjs/common';
import { sourceTextDependencies, type Extractor, type ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SentinelService, SENTINEL_EXTRACTOR_VERSION } from './sentinel.service';

/**
 * Sensitivity classification as a node of the extraction DAG (JJ-21/JJ-85).
 * Classifies an item's text before the external-LLM extractors run; the routing
 * guard in the pipeline gates those on the resulting tier. It is ALWAYS enabled —
 * the deterministic detectors need no key — so every item gets a tier.
 *
 * Uses the same payload-aware source-text dependency as every text consumer:
 * transcription for audio/typed text and OCR for documents. Blank OCR is not a
 * usable generation and does not trigger classification.
 */
@Injectable()
export class SentinelExtractor implements Extractor {
  readonly kind = 'sentinel' as const;
  readonly version = SENTINEL_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = sourceTextDependencies();

  constructor(private readonly sentinel: SentinelService) {}

  // Per-user + async to match the Extractor contract (AI config is per-user
  // now), though the sentinel itself is userId-independent and always enabled.
  enabled(_userId: string): Promise<boolean> {
    return Promise.resolve(this.sentinel.enabled);
  }

  appliesTo(item: InboxItemEntity): boolean {
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.sentinel.enqueueSentinel(item.id);
  }
}
