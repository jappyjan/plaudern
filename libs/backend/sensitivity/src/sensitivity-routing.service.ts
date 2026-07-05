import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  HELD_NEEDS_LOCAL_MODEL,
  isLocalOnlyTier,
  type ExtractionKind,
  type SensitivityRoutingDecision,
  type SensitivityTier,
} from '@plaudern/contracts';
import { ItemSensitivityEntity } from '@plaudern/persistence';

/**
 * The `<KIND>_BASE_URL` env each gated extractor's provider reads (with the
 * provider's own external default). The routing guard reads the SAME variable
 * the provider reads, so its view of "where will this kind's LLM call go" is
 * exactly the endpoint the provider will use — no drift, no override needed.
 * `entities` and `relations` share the entity-extraction endpoint.
 */
const KIND_BASE_URL_ENV: Partial<Record<ExtractionKind, { env: string; fallback: string }>> = {
  summary: { env: 'SUMMARIZATION_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  embedding: { env: 'EMBEDDINGS_BASE_URL', fallback: 'https://api.openai.com/v1' },
  entities: { env: 'ENTITY_EXTRACTION_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  relations: { env: 'ENTITY_EXTRACTION_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  topics: { env: 'TOPICS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  commitments: { env: 'COMMITMENTS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  tasks: { env: 'TASKS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  facts: { env: 'FACTS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  questions: { env: 'QUESTIONS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  decisions: { env: 'DECISIONS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
  reminders: { env: 'REMINDERS_BASE_URL', fallback: 'https://api.deepseek.com/v1' },
};

/**
 * The local-only routing guard (JJ-21) — the crux of the ticket. Enforces one
 * invariant: **a `sensitive`/`secret` item can only ever reach a validated-LOCAL
 * LLM endpoint, or be held — never an external one, under any config.**
 *
 * A `sensitive`/`secret` item may run an external-LLM extractor ONLY when that
 * kind's configured endpoint (`<KIND>_BASE_URL`, the exact var its provider
 * reads) resolves to a loopback/private address. Because the guard reads the
 * same env the provider reads, releasing the item means the provider will make
 * its call to that already-validated local endpoint — no per-run override, no
 * trust in operator intent. Any kind still pointed at a cloud endpoint HOLDS
 * ("held: needs local model") rather than leaking. `public`/`normal` items are
 * unaffected and use the configured endpoint as before.
 */
@Injectable()
export class SensitivityRoutingService {
  private readonly logger = new Logger(SensitivityRoutingService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(ItemSensitivityEntity)
    private readonly rows: Repository<ItemSensitivityEntity>,
  ) {}

  /** The endpoint a gated kind's provider will call (same env the provider reads). */
  kindBaseUrl(kind: ExtractionKind): string | null {
    const map = KIND_BASE_URL_ENV[kind];
    if (!map) return null;
    return (this.config.get<string>(map.env, map.fallback) ?? map.fallback).replace(/\/+$/, '');
  }

  /** Whether a gated kind is configured to call a validated-LOCAL endpoint. */
  kindRoutesLocal(kind: ExtractionKind): boolean {
    return isLocalEndpoint(this.kindBaseUrl(kind));
  }

  /**
   * Pure routing decision for a known tier + kind (no item lookup). Never
   * returns `local` for an external endpoint — the invariant lives here.
   */
  resolveTier(
    tier: SensitivityTier,
    kind: ExtractionKind,
  ): Exclude<SensitivityRoutingDecision, 'wait'> {
    if (!isLocalOnlyTier(tier)) return 'external';
    return this.kindRoutesLocal(kind) ? 'local' : 'hold';
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
   * The routing decision for one item + gated kind. `wait` means the sentinel
   * hasn't classified the item yet — the caller should skip and re-evaluate on
   * sentinel completion.
   */
  async decide(inboxItemId: string, kind: ExtractionKind): Promise<SensitivityRoutingDecision> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row) return 'wait';
    return this.resolveTier(this.effectiveTierOf(row), kind);
  }

  /** Mark an item held for lack of a local endpoint (idempotent). */
  async markHeld(inboxItemId: string): Promise<void> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row || row.held) return;
    row.held = true;
    row.heldReason = HELD_NEEDS_LOCAL_MODEL;
    await this.rows.save(row);
    this.logger.log(
      `held item ${inboxItemId}: sensitive content and no local model endpoint configured`,
    );
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

/**
 * Whether an LLM base URL points at a loopback/private (on-box or LAN) endpoint
 * that sensitive content may be sent to. Anything that doesn't clearly resolve
 * to a private address is treated as EXTERNAL (fail-closed): a parse failure,
 * a public host, or an unset endpoint all return false → the item is held.
 */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // *.local / *.internal / *.lan mDNS + private DNS suffixes.
  if (/\.(local|internal|lan)$/.test(host)) return true;
  // Bare single-label hostname (no dot) — a Docker/Compose service or LAN name
  // (e.g. http://ollama:11434), never a public FQDN.
  if (!host.includes('.')) return true;
  // IPv4 loopback / RFC1918 private / link-local ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }
  return false;
}
