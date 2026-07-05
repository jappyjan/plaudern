import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  HELD_NEEDS_LOCAL_MODEL,
  isLocalOnlyTier,
  type SensitivityRoutingDecision,
  type SensitivityTier,
} from '@plaudern/contracts';
import { ItemSensitivityEntity } from '@plaudern/persistence';

/**
 * The local-only routing guard (JJ-21) — the crux of the ticket. Given an
 * item's effective sensitivity tier, decides whether an external-LLM extraction
 * may run:
 *
 * - `public`/`normal`         → `external` (may use the configured provider).
 * - `sensitive`/`secret` with a LOCAL model tier configured → `local` (release;
 *   the operator points the extractor endpoints at the local tier).
 * - `sensitive`/`secret` with NO local tier → `hold` — the essential
 *   graceful-degradation: the item is withheld, marked "held: needs local
 *   model", and NEVER sent to an external provider.
 * - unclassified (sentinel hasn't run yet) → `wait`.
 *
 * A local tier is "configured" when LOCAL_LLM_ENABLED=true (optionally with
 * LOCAL_LLM_BASE_URL/MODEL/API_KEY), mirroring the EMBEDDINGS_* keyless-Ollama
 * opt-in.
 */
@Injectable()
export class SensitivityRoutingService {
  private readonly logger = new Logger(SensitivityRoutingService.name);
  private readonly enabled: boolean;
  readonly localBaseUrl: string;
  readonly localModel: string;

  constructor(
    config: ConfigService,
    @InjectRepository(ItemSensitivityEntity)
    private readonly rows: Repository<ItemSensitivityEntity>,
  ) {
    this.enabled = config.get<string>('LOCAL_LLM_ENABLED', 'false') === 'true';
    this.localBaseUrl = config
      .get<string>('LOCAL_LLM_BASE_URL', 'http://localhost:11434/v1')
      .replace(/\/+$/, '');
    this.localModel = config.get<string>('LOCAL_LLM_MODEL', 'llama3.1');
  }

  /** Whether a local model tier is available to route sensitive items to. */
  get localTierConfigured(): boolean {
    return this.enabled;
  }

  /** Pure routing decision for a known tier (no item lookup). */
  resolveTier(tier: SensitivityTier): Exclude<SensitivityRoutingDecision, 'wait'> {
    if (!isLocalOnlyTier(tier)) return 'external';
    return this.localTierConfigured ? 'local' : 'hold';
  }

  /** The effective tier for an item (manual override folded over detected). */
  effectiveTierOf(row: ItemSensitivityEntity): SensitivityTier {
    return row.manualTier ?? row.detectedTier;
  }

  /** Effective tiers for many items at once (search result enrichment). */
  async effectiveTiers(inboxItemIds: string[]): Promise<Map<string, SensitivityTier>> {
    const map = new Map<string, SensitivityTier>();
    const unique = [...new Set(inboxItemIds)].filter(Boolean);
    if (unique.length === 0) return map;
    const rows = await this.rows.find({ where: { inboxItemId: In(unique) } });
    for (const row of rows) map.set(row.inboxItemId, this.effectiveTierOf(row));
    return map;
  }

  /**
   * The routing decision for one item. `wait` means the sentinel hasn't
   * classified it yet — the caller should skip and re-evaluate on sentinel
   * completion.
   */
  async decide(inboxItemId: string): Promise<SensitivityRoutingDecision> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row) return 'wait';
    return this.resolveTier(this.effectiveTierOf(row));
  }

  /** Mark an item held for lack of a local tier (idempotent). */
  async markHeld(inboxItemId: string): Promise<void> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row || row.held) return;
    row.held = true;
    row.heldReason = HELD_NEEDS_LOCAL_MODEL;
    await this.rows.save(row);
    this.logger.log(`held item ${inboxItemId}: sensitive content and no local model tier configured`);
  }

  /** Clear a hold once processing is allowed again (idempotent). */
  async clearHeld(inboxItemId: string): Promise<void> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row || !row.held) return;
    row.held = false;
    row.heldReason = null;
    await this.rows.save(row);
  }
}
