import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SentinelService, SENTINEL_EXTRACTOR_VERSION } from './sentinel.service';

/**
 * Sensitivity classification as a node of the extraction DAG (JJ-21/JJ-85).
 * Classifies an item's text before the external-LLM extractors run; the routing
 * guard in the pipeline gates those on the resulting tier. It is ALWAYS enabled —
 * the deterministic detectors need no key — so every item gets a tier.
 *
 * Depends on BOTH transcription and OCR as `settled`: audio/typed-note items are
 * classified from their transcription, while scanned image/PDF items (JJ-85) are
 * classified from the OCR-derived text — the sentinel context reads whichever is
 * present. `settled` (not `succeeded`) is used so the sentinel triggers off OCR
 * for documents that carry no transcription of their own, including a blank scan
 * (OCR succeeds with empty text) which must still get a `normal` tier rather than
 * leave `docmeta` held forever. Whichever dependency does not apply to the item
 * is simply skipped by the readiness gate.
 */
@Injectable()
export class SentinelExtractor implements Extractor {
  readonly kind = 'sentinel' as const;
  readonly version = SENTINEL_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'settled' },
    { kind: 'ocr', requires: 'settled' },
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
