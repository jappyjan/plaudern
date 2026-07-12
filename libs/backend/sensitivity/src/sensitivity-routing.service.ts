import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  HELD_NEEDS_LOCAL_MODEL,
  isLocalOnlyTier,
  type AiCapability,
  type ExtractionKind,
  type SensitivityRoutingDecision,
  type SensitivityTier,
} from '@plaudern/contracts';
import { AiConfigService } from '@plaudern/ai-config';
import { ItemSensitivityEntity } from '@plaudern/persistence';

/**
 * The AI CAPABILITY each gated extractor's provider resolves its endpoint from.
 * Since #107 moved AI config out of env vars into per-user DB settings, a
 * provider's base URL comes from `AiConfigService.resolve(userId, capability)`
 * — so the routing guard MUST resolve the SAME capability, per-user, to see the
 * exact endpoint the provider will call. This is the JJ-21 invariant restated
 * for the DB world: "the guard reads the SAME endpoint the provider reads".
 * Reading a now-stale `<KIND>_BASE_URL` env (as this service used to) would let
 * the guard approve "release to local" against an endpoint the provider no
 * longer uses (a LEAK), or hold-forever when env is unset but the DB is local.
 *
 * `relations` resolves `entity_relations` (which inherits the
 * `entity_extraction` connection when unset — exactly what the provider does).
 * `ocr`/`docmeta` (JJ-85) resolve the `ocr`/`docmeta` capabilities. Note: `ocr`
 * itself is NOT a gated `EXTERNAL_LLM_KIND` (it is the classification-enabling
 * FIRST external call over a scanned document, so gating it would hold-forever);
 * its capability is mapped here only so an endpoint lookup is available and
 * consistent. `docmeta` and every text extractor downstream of the OCR-derived
 * transcript ARE gated on the sentinel's classification of that text.
 */
const KIND_CAPABILITY: Partial<Record<ExtractionKind, AiCapability>> = {
  summary: 'summarization',
  embedding: 'embeddings',
  entities: 'entity_extraction',
  relations: 'entity_relations',
  topics: 'topics',
  commitments: 'commitments',
  tasks: 'tasks',
  facts: 'facts',
  questions: 'questions',
  decisions: 'decisions',
  reminders: 'reminders',
  ocr: 'ocr',
  docmeta: 'docmeta',
};

/**
 * The local-only routing guard (JJ-21) — the crux of the ticket. Enforces one
 * invariant: **a `sensitive`/`secret` item can only ever reach a validated-LOCAL
 * LLM endpoint, or be held — never an external one, under any config.**
 *
 * A `sensitive`/`secret` item may run an external-LLM extractor ONLY when that
 * kind's configured endpoint — the one its provider resolves from the user's
 * DB-backed AI config (`AiConfigService.resolve(userId, capability)`, the exact
 * connection the provider will use) — points at a loopback/private address.
 * Because the guard resolves the SAME per-user capability the provider resolves,
 * releasing the item means the provider will make its call to that
 * already-validated local endpoint — no per-run override, no trust in operator
 * intent. Any kind still resolving to a cloud endpoint HOLDS ("held: needs local
 * model") rather than leaking. `public`/`normal` items are unaffected and use
 * the configured endpoint as before.
 */
@Injectable()
export class SensitivityRoutingService {
  private readonly logger = new Logger(SensitivityRoutingService.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    @InjectRepository(ItemSensitivityEntity)
    private readonly rows: Repository<ItemSensitivityEntity>,
  ) {}

  /**
   * The endpoint a gated kind's provider will call FOR THIS USER — resolved
   * through the same DB-backed `AiConfigService` the provider uses, so the guard
   * never validates a different endpoint than the one bytes actually go to.
   * Returns null when the capability has no usable provider (unconfigured /
   * disabled): the extractor won't run in that case, and null is treated as
   * non-local (fail-closed) by `isLocalEndpoint`.
   */
  async kindBaseUrl(userId: string, kind: ExtractionKind): Promise<string | null> {
    const capability = KIND_CAPABILITY[kind];
    if (!capability) return null;
    const resolved = await this.aiConfig.resolve(userId, capability);
    return resolved ? resolved.baseUrl : null;
  }

  /** Whether a gated kind resolves to a validated-LOCAL endpoint for this user. */
  async kindRoutesLocal(userId: string, kind: ExtractionKind): Promise<boolean> {
    return isLocalEndpoint(await this.kindBaseUrl(userId, kind));
  }

  /**
   * Pure routing decision for a known tier + kind + user. Never returns `local`
   * for an external endpoint — the invariant lives here. Async because the
   * endpoint is now a per-user DB resolution, not an env read.
   */
  async resolveTier(
    tier: SensitivityTier,
    userId: string,
    kind: ExtractionKind,
  ): Promise<Exclude<SensitivityRoutingDecision, 'wait'>> {
    if (!isLocalOnlyTier(tier)) return 'external';
    return (await this.kindRoutesLocal(userId, kind)) ? 'local' : 'hold';
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
   * The routing decision for one item + gated kind. `userId` is the item owner
   * — the user whose DB config resolves the provider endpoint (per-item decision,
   * per-user resolution). `wait` means the sentinel hasn't classified the item
   * yet — the caller should skip and re-evaluate on sentinel completion.
   */
  async decide(
    userId: string,
    inboxItemId: string,
    kind: ExtractionKind,
  ): Promise<SensitivityRoutingDecision> {
    const row = await this.rows.findOne({ where: { inboxItemId } });
    if (!row) return 'wait';
    return this.resolveTier(this.effectiveTierOf(row), userId, kind);
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
  if (host === '0.0.0.0') return true;
  // IPv6 literals contain a colon. Validate EXPLICITLY and fail closed — ONLY
  // loopback (::1), Unique-Local fc00::/7 (fc../fd..) and link-local fe80::/10
  // count as local; every other IPv6 (incl. public hosts like [2606:4700::1])
  // is external. Must run BEFORE the dotless-hostname rule, which an IPv6
  // literal (no dots) would otherwise wrongly match.
  if (host.includes(':')) {
    if (host === '::1') return true; // loopback
    // AWS IMDSv6 cloud-metadata address (JJ-86): sits inside fd00::/8 ULA space
    // but is semantically non-local (SSRF target) — exclude it explicitly
    // before the generic ULA rule below, mirroring the IPv4 169.254.169.254
    // exclusion. The IPv4-mapped form (::ffff:169.254.169.254) already falls
    // through to `return false` below since it doesn't match the f[cd]/fe8-b
    // prefixes, so it needs no separate check.
    if (host === 'fd00:ec2::254') return false;
    if (/^f[cd][0-9a-f]*(?::|$)/.test(host)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]*(?::|$)/.test(host)) return true; // fe80::/10 link-local
    return false;
  }
  // *.local / *.internal / *.lan mDNS + private DNS suffixes.
  if (/\.(local|internal|lan)$/.test(host)) return true;
  // Bare single-label hostname (no dot, not an IPv6 literal handled above) — a
  // Docker/Compose service or LAN name (e.g. http://ollama:11434), never a
  // public FQDN.
  if (!host.includes('.')) return true;
  // IPv4 loopback / RFC1918 private / link-local ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Cloud-metadata IP is non-local semantically (SSRF target) — exclude it
    // explicitly even though it sits in the link-local block.
    if (host === '169.254.169.254') return false;
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }
  return false;
}
