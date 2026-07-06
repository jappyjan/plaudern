import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SentinelService, SENTINEL_EXTRACTOR_VERSION } from './sentinel.service';

/**
 * Sensitivity classification as a node of the extraction DAG (JJ-21). Depends
 * only on transcription (nothing to classify without text). It is ALWAYS
 * enabled — the deterministic detectors need no key — so every item gets a tier
 * before the external-LLM extractors are allowed to run; the routing guard in
 * the pipeline gates those on the resulting tier.
 */
@Injectable()
export class SentinelExtractor implements Extractor {
  readonly kind = 'sentinel' as const;
  readonly version = SENTINEL_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
  ];

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
