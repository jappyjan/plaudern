import type { JournalCitationKind, JournalPeriodType } from '@plaudern/contracts';

/** One numbered source handed to the generator, referenced as `[n]` in the body. */
export interface JournalProviderSource {
  marker: number;
  kind: JournalCitationKind;
  title: string | null;
  /** ISO 8601 occurrence time, so the model can order the narrative. */
  occurredAt: string;
  text: string;
}

export interface JournalProviderInput {
  periodType: JournalPeriodType;
  periodKey: string;
  /** Human label for the period (e.g. "Saturday, 14 June 2026", "June 2026"). */
  periodLabel: string;
  /** Sources ordered oldest-first, so the numbering follows the timeline. */
  sources: JournalProviderSource[];
  /**
   * The current entry body, when one exists — the model UPDATES it rather than
   * rewriting from scratch, so an entry evolves coherently as more signals land.
   */
  previousMarkdown?: string | null;
}

export interface JournalProviderResult {
  /** The diary/review body as GitHub-flavored Markdown with `[n]` markers. */
  markdown: string;
  /** Concrete model that produced the entry, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Journal composition backend (JJ-17). The default is an OpenAI-compatible
 * `/chat/completions` provider (DeepSeek by default), mirroring the other LLM
 * kinds; the feature ships DISABLED until an API key (or an explicit enable flag
 * for keyless local endpoints) is configured. Tests override the DI token with
 * a fake.
 */
export interface JournalProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  generate(input: JournalProviderInput): Promise<JournalProviderResult>;
}

export const JOURNAL_PROVIDER = Symbol('JOURNAL_PROVIDER');
