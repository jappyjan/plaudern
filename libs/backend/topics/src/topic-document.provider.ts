/** One numbered source handed to the generator, referenced as `[n]` in the body. */
export interface TopicDocumentSource {
  /** 1-based marker the document body cites as `[n]`. */
  marker: number;
  inboxItemId: string;
  title: string | null;
  /** ISO 8601 occurrence time, so the model can order a timeline. */
  occurredAt: string;
  /** The source text (its summary when available, else transcript excerpt). */
  text: string;
  /** Detected content language (2-letter code), for context. */
  language?: string;
}

export interface TopicDocumentInput {
  topicName: string;
  topicDescription?: string | null;
  /** Sources ordered oldest-first, so the numbering follows the timeline. */
  sources: TopicDocumentSource[];
  /**
   * The current document body, when one exists — the model UPDATES it rather
   * than rewriting from scratch, so the living document evolves coherently.
   */
  previousMarkdown?: string | null;
}

export interface TopicDocumentResult {
  /** The living document body as GitHub-flavored Markdown with `[n]` markers. */
  markdown: string;
  /** Concrete model that produced the document, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Living-document generation backend (JJ-12). The default is an
 * OpenAI-compatible `/chat/completions` provider (DeepSeek by default),
 * mirroring summarization/topics; the feature ships DISABLED until an API key
 * (or an explicit enable flag for keyless local endpoints) is configured. Tests
 * override the DI token with a fake.
 */
export interface TopicDocumentProvider {
  readonly id: string;
  /**
   * Generate for a specific user — the user's DB-backed AI config
   * (`@plaudern/ai-config`, capability `topic_docs`) decides the endpoint/model.
   * Throws if the user has not configured the topic_docs capability.
   */
  generate(userId: string, input: TopicDocumentInput): Promise<TopicDocumentResult>;
}

export const TOPIC_DOCUMENT_PROVIDER = Symbol('TOPIC_DOCUMENT_PROVIDER');
