import type { SensitivityCategory, SensitivityTier } from '@plaudern/contracts';

/** Input to the sentinel classifier — the transcript to scan. */
export interface SentinelClassifyInput {
  transcript: string;
  language?: string;
  occurredAt?: string;
}

/** One nuanced finding from the LLM classifier: a category + the verbatim span. */
export interface SentinelFinding {
  category: SensitivityCategory;
  /** Verbatim substring of the transcript, located to build a mask span. */
  quote: string;
}

export interface SentinelLlmResult {
  tier: SensitivityTier;
  findings: SentinelFinding[];
  model?: string;
  raw?: unknown;
}

/**
 * The OPTIONAL LLM leg of the sentinel (JJ-21). It catches nuanced sensitivity
 * the deterministic detectors can't — health details, other people's secrets.
 * Ships DISABLED (no key ⇒ `enabled === false`); the deterministic detectors
 * always run regardless. Gated behind SENTINEL_LLM_API_KEY (cloud) or
 * SENTINEL_LLM_ENABLED=true (keyless local endpoints such as Ollama).
 *
 * IMPORTANT: this classifier is itself an LLM call. It must therefore be
 * pointed at a LOCAL endpoint in any deploy that wants sensitive transcripts to
 * never leave — it sees the raw transcript before the tier is known.
 */
export interface SentinelLlmProvider {
  readonly id: string;
  readonly enabled: boolean;
  classify(input: SentinelClassifyInput): Promise<SentinelLlmResult>;
}

export const SENTINEL_LLM_PROVIDER = Symbol('SENTINEL_LLM_PROVIDER');
