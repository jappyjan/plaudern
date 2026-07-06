import { z } from 'zod';
import { extractionKindSchema, type ExtractionKind } from './inbox';

/**
 * Sensitivity tiers (JJ-21). A sentinel pass classifies every extraction's
 * content into one of these; the tier governs BOTH how the content is shown
 * (masked-by-default for `sensitive`/`secret`) AND — crucially — whether it may
 * be sent to an EXTERNAL LLM provider. Ordered least → most sensitive:
 *
 * - `public`   — explicitly shareable (reserved; the classifier never assigns
 *                it automatically, only a user override can).
 * - `normal`   — the default; nothing sensitive detected. External LLM OK.
 * - `sensitive`— health details, national IDs, IBANs, other people's secrets.
 *                Local-model tier ONLY; masked by default.
 * - `secret`   — passwords/credentials, API keys, private keys, card numbers.
 *                Local-model tier ONLY; masked by default.
 */
export const sensitivityTierSchema = z.enum(['public', 'normal', 'sensitive', 'secret']);
export type SensitivityTier = z.infer<typeof sensitivityTierSchema>;

/** Rank of a tier for ordering/max — higher = more sensitive. */
const TIER_RANK: Record<SensitivityTier, number> = {
  public: 0,
  normal: 1,
  sensitive: 2,
  secret: 3,
};

/** The more-sensitive of two tiers (used to fold many detections into one). */
export function maxTier(a: SensitivityTier, b: SensitivityTier): SensitivityTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Whether a tier must be kept off external LLM providers (local-only routing).
 * `public`/`normal` may go external; `sensitive`/`secret` may not.
 */
export function isLocalOnlyTier(tier: SensitivityTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.sensitive;
}

/** Whether content at this tier is masked by default in the UI. */
export function isMaskedTier(tier: SensitivityTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.sensitive;
}

/**
 * Detection categories. The deterministic detectors (no key needed) emit the
 * first four; the optional LLM classifier can additionally emit `health` and
 * `other_secret` (nuanced cases the regexes can't catch).
 */
export const sensitivityCategorySchema = z.enum([
  'iban',
  'credit_card',
  'credential',
  'national_id',
  'health',
  'other_secret',
]);
export type SensitivityCategory = z.infer<typeof sensitivityCategorySchema>;

/** Which tier a given detection category implies. */
export const CATEGORY_TIER: Record<SensitivityCategory, SensitivityTier> = {
  credit_card: 'secret',
  credential: 'secret',
  iban: 'sensitive',
  national_id: 'sensitive',
  health: 'sensitive',
  other_secret: 'sensitive',
};

/** A matched span of sensitive content — a half-open [start, end) char range. */
export const sensitivitySpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  category: sensitivityCategorySchema,
});
export type SensitivitySpan = z.infer<typeof sensitivitySpanSchema>;

/** A rolled-up count of one detection category. */
export const sensitivityDetectionSchema = z.object({
  category: sensitivityCategorySchema,
  count: z.number().int().positive(),
});
export type SensitivityDetection = z.infer<typeof sensitivityDetectionSchema>;

/**
 * The JSON payload stored in the `sentinel` extraction row's `content`. Carries
 * the DETECTED (extraction-owned) tier plus the spans that let the web mask the
 * exact secret substrings in the transcript it already renders. A user's manual
 * override is NOT here (extractions are append-only) — it lives on the mutable
 * item_sensitivity row and is folded into the effective tier server-side.
 */
export const sentinelPayloadSchema = z.object({
  detectedTier: sensitivityTierSchema,
  detections: z.array(sensitivityDetectionSchema),
  spans: z.array(sensitivitySpanSchema),
  /** Whether the optional LLM classifier ran (vs. deterministic-only). */
  llmClassified: z.boolean(),
});
export type SentinelPayload = z.infer<typeof sentinelPayloadSchema>;

/**
 * The item's sensitivity read model (exposed at GET /v1/inbox/:id/sensitivity).
 * `effectiveTier` already folds a user's `manualTier` override over the
 * classifier's `detectedTier`.
 */
export const itemSensitivitySchema = z.object({
  inboxItemId: z.string().uuid(),
  detectedTier: sensitivityTierSchema,
  manualTier: sensitivityTierSchema.nullable(),
  effectiveTier: sensitivityTierSchema,
  detections: z.array(sensitivityDetectionSchema),
  spans: z.array(sensitivitySpanSchema),
  llmClassified: z.boolean(),
  /**
   * True when an external-LLM extraction was withheld because the item is
   * local-only but no local model tier is configured ("held: needs local
   * model"). Cleared once a local tier is configured and the item re-runs.
   */
  held: z.boolean(),
  heldReason: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type ItemSensitivityDto = z.infer<typeof itemSensitivitySchema>;

/** Body of PATCH /v1/inbox/:id/sensitivity — a user's manual tier override. */
export const setSensitivityOverrideSchema = z.object({
  /** New manual tier, or null to clear the override and fall back to detected. */
  manualTier: sensitivityTierSchema.nullable(),
});
export type SetSensitivityOverride = z.infer<typeof setSensitivityOverrideSchema>;

/** Reason string recorded on a held item when no local tier is available. */
export const HELD_NEEDS_LOCAL_MODEL = 'needs-local-model';

/**
 * Extraction kinds that send an item's TEXT CONTENT to an (optionally external)
 * LLM/embedding provider. These are the kinds the routing guard gates: for a
 * local-only item they run only when a local tier is configured, else they are
 * held. Transcription/diarization are audio-stage and upstream of
 * classification, so they are intentionally NOT gated here.
 *
 * `docmeta` (JJ-85) IS gated: it reads the OCR-derived text of a scanned
 * image/PDF, so a sensitive scanned invoice/contract/ID must be held/local-routed
 * exactly like any other sensitive item once the sentinel has classified that
 * text. `ocr` itself is deliberately NOT here — it is the FIRST external call
 * that produces the text the sentinel classifies from (an image carries no
 * transcription to pre-classify), so gating it on the not-yet-known tier would
 * hold-forever. OCR is accepted as the classification-enabling call; everything
 * downstream of its text (docmeta, entities, facts, …) is gated on the result.
 */
export const EXTERNAL_LLM_KINDS: ReadonlySet<ExtractionKind> = new Set<ExtractionKind>([
  'summary',
  'embedding',
  'entities',
  'topics',
  'relations',
  'commitments',
  'tasks',
  'facts',
  'questions',
  'decisions',
  'reminders',
  'docmeta',
]);

/** Whether an extraction kind is gated by the sensitivity routing guard. */
export function isExternalLlmKind(kind: ExtractionKind): boolean {
  return EXTERNAL_LLM_KINDS.has(kind);
}

/** The routing decision for one (item, external-LLM extractor) pair. */
export type SensitivityRoutingDecision = 'external' | 'local' | 'hold' | 'wait';

// Referenced so the import is used even if tree-shaken elsewhere.
export const SENTINEL_KIND: ExtractionKind = extractionKindSchema.enum.sentinel;

/**
 * Mask the sensitive spans in `text`, replacing each with a fixed-width marker.
 * Spans are half-open [start, end) char ranges; overlapping/out-of-order spans
 * are handled. Used by the web to render masked-by-default content.
 */
export function maskSpans(text: string, spans: SensitivitySpan[], marker = '••••••'): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of sorted) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) out += text.slice(cursor, start);
    if (end > start) out += marker;
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}
