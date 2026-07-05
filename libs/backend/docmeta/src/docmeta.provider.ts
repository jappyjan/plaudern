import type { ExtractedDocMeta } from '@plaudern/contracts';

export interface DocMetaInput {
  /** The OCR'd full text of the document. */
  text: string;
  /** Detected document language (2-letter code), for context. */
  language?: string;
  /** When the document was captured/scanned (ISO) — anchors relative dates. */
  occurredAt?: string;
}

export interface DocMetaResult {
  /** The structured document metadata, or null when the text isn't a document. */
  docMeta: ExtractedDocMeta | null;
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Document-understanding backend. Reads the OCR TEXT (not the image) and returns
 * a classified document with key fields — so it can run on the cheap text tier
 * (DeepSeek) even when only OCR needs a vision model. The default is an
 * OpenAI-compatible `/chat/completions` provider, mirroring the reminders /
 * decisions providers. Tests override the DI token with a fake.
 */
export interface DocMetaProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: DocMetaInput): Promise<DocMetaResult>;
}

export const DOCMETA_PROVIDER = Symbol('DOCMETA_PROVIDER');
