import type { SummaryLayout } from '@plaudern/contracts';

/** One speaker in the recording, given to the model so it can @-mention people. */
export interface SummarizationSpeaker {
  /** Diarization label the markdown must use in `@[LABEL]` mentions. */
  label: string;
  /** Resolved display name (real name, or a "Speaker N" placeholder). */
  displayName: string;
  /** Whether the person is a confirmed contact — purely informational. */
  confirmed: boolean;
  /** True when this speaker is the account owner ("me"), so action items read as theirs. */
  isSelf: boolean;
}

export interface SummarizationInput {
  /**
   * The transcript to summarize. When diarization is available this is a
   * speaker-attributed transcript (each block prefixed with its `LABEL`), so
   * the model can attribute statements to the right person; otherwise it is the
   * plain transcript text.
   */
  transcript: string;
  speakers: SummarizationSpeaker[];
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /**
   * Forced output language as an English name (e.g. "German"), from the user's
   * per-account preference. Undefined => write in the transcript's own language.
   */
  targetLanguage?: string;
  occurredAt?: string;
  durationSeconds?: number;
  /**
   * What the transcript actually is: a speech-to-text transcript of a
   * recording, or the verbatim body of a typed note (passthrough). Steers the
   * prompt wording; defaults to 'recording'.
   */
  sourceKind?: 'recording' | 'note';
}

export interface SummarizationResult {
  title: string;
  layout: SummaryLayout;
  /** Markdown body; may contain mermaid fences and `@[LABEL]` speaker mentions. */
  markdown: string;
  /** Optional markdown for off-topic tangents, kept separate from `markdown`. */
  offTopic?: string | null;
  /** Concrete model that produced the summary, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Summarization backend. The default is an OpenAI-compatible chat-completions
 * provider (works with DeepSeek, OpenAI, OpenRouter, a local llama.cpp gateway,
 * …). Tests override the DI token with a fake.
 */
export interface SummarizationProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  summarize(input: SummarizationInput): Promise<SummarizationResult>;
}

export const SUMMARIZATION_PROVIDER = Symbol('SUMMARIZATION_PROVIDER');
