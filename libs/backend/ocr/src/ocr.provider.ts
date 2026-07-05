export interface OcrInput {
  /** A `data:` URL (base64) of the document image, ready for a vision model. */
  imageDataUrl: string;
  /** The blob's content type (e.g. image/jpeg, application/pdf). */
  contentType: string;
  /** Original filename, for the model's context. */
  filename?: string;
}

export interface OcrResult {
  /** The recognized full text of the document. */
  text: string;
  /** Detected document language (2-letter code), if the model reported one. */
  language?: string;
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * OCR backend: reads a document image and returns its text. The default is an
 * OpenAI-compatible `/chat/completions` endpoint with a VISION model (the image
 * is sent as an `image_url` data URL). This is a NEW LLM kind gated behind its
 * own vision key/flag — DeepSeek, the default text tier, cannot do vision.
 * Tests override the DI token with a fake.
 */
export interface OcrProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (has a key or is opted in). */
  readonly enabled: boolean;
  recognize(input: OcrInput): Promise<OcrResult>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');
