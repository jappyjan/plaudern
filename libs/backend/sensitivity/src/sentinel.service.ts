import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import type { ItemSensitivityDto, SensitivityTier } from '@plaudern/contracts';
import { ItemSensitivityEntity } from '@plaudern/persistence';
import { SENTINEL_QUEUE, type SentinelQueue } from './sentinel.job';

/**
 * Version of the sentinel classifier (kind@version). Bump when detection
 * meaningfully improves so a startup backfill re-classifies older items.
 */
export const SENTINEL_EXTRACTOR_VERSION = 1;

/** Provenance id recorded on the append-only `sentinel` extraction rows. */
export const SENTINEL_PROVIDER_ID = 'sentinel';

/**
 * Owns the sentinel pipeline step (JJ-21): enqueue + the per-item sensitivity
 * read model + the user's manual tier override. The deterministic detectors
 * need no key, so the sentinel is ALWAYS enabled — the optional LLM leg is
 * gated inside the classifier, not here. Persisting a classification lives in
 * SentinelPersistenceService so the processor never edges back to this service.
 */
@Injectable()
export class SentinelService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(SENTINEL_QUEUE)
    private readonly queue: SentinelQueue,
    @InjectRepository(ItemSensitivityEntity)
    private readonly rows: Repository<ItemSensitivityEntity>,
  ) {}

  /** Deterministic detection always runs, so the sentinel is always enabled. */
  get enabled(): boolean {
    return true;
  }

  /** Append a fresh `queued` sentinel row and hand the job to the queue. */
  async enqueueSentinel(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'sentinel',
      SENTINEL_PROVIDER_ID,
      SENTINEL_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  /** The item's sensitivity read model, or a `normal`/unclassified default. */
  async getItemSensitivity(userId: string, inboxItemId: string): Promise<ItemSensitivityDto> {
    // Authorization: throws NotFound if the item isn't the user's.
    await this.inbox.getItem(userId, inboxItemId);
    const row = await this.rows.findOne({ where: { inboxItemId, userId } });
    if (!row) return defaultSensitivity(inboxItemId);
    return toDto(row);
  }

  /** Set (or clear, with null) a user's manual tier override. */
  async setManualTier(
    userId: string,
    inboxItemId: string,
    manualTier: SensitivityTier | null,
  ): Promise<ItemSensitivityDto> {
    await this.inbox.getItem(userId, inboxItemId);
    let row = await this.rows.findOne({ where: { inboxItemId, userId } });
    if (!row) {
      // No classification yet — create a minimal row carrying just the override.
      row = this.rows.create({
        userId,
        inboxItemId,
        extractionId: inboxItemId, // placeholder; overwritten on next classification
        detectedTier: 'normal',
        detections: [],
        spans: [],
        llmClassified: false,
        held: false,
      });
    }
    row.manualTier = manualTier;
    const saved = await this.rows.save(row);
    return toDto(saved);
  }
}

function toDto(row: ItemSensitivityEntity): ItemSensitivityDto {
  const effectiveTier = row.manualTier ?? row.detectedTier;
  return {
    inboxItemId: row.inboxItemId,
    detectedTier: row.detectedTier,
    manualTier: row.manualTier,
    effectiveTier,
    detections: row.detections ?? [],
    spans: row.spans ?? [],
    llmClassified: row.llmClassified,
    held: row.held,
    heldReason: row.heldReason,
    updatedAt: (row.updatedAt instanceof Date
      ? row.updatedAt
      : new Date(row.updatedAt ?? Date.now())
    ).toISOString(),
  };
}

function defaultSensitivity(inboxItemId: string): ItemSensitivityDto {
  return {
    inboxItemId,
    detectedTier: 'normal',
    manualTier: null,
    effectiveTier: 'normal',
    detections: [],
    spans: [],
    llmClassified: false,
    held: false,
    heldReason: null,
    updatedAt: new Date(0).toISOString(),
  };
}
