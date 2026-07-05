import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `ocr` extraction kind (JJ-30) — full-text recognition of a
 * scanned image or PDF. A vision-capable LLM reads the document and returns its
 * text, which is stored on the append-only `ocr` extraction row's `content`
 * (making the physical world searchable memory) and consumed by the downstream
 * `docmeta` extractor.
 *
 * OCR is a NEW LLM kind: it ships DISABLED until a vision-capable provider is
 * configured (OCR_API_KEY / OCR_ENABLED). DeepSeek — the default summarization
 * tier — is text-only, so OCR must be pointed at a vision model explicitly.
 */

/**
 * The persisted shape of an `ocr` extraction's `content` provenance. The actual
 * recognized text lives inline on the extraction row's `content`; this JSON is
 * only used when we need structured provenance and is otherwise not required.
 */
export const ocrExtractionPayloadSchema = z.object({
  model: z.string(),
  /** Number of characters recognized (for a quick "did it read anything" check). */
  charCount: z.number().int().nonnegative(),
});
export type OcrExtractionPayload = z.infer<typeof ocrExtractionPayloadSchema>;

/**
 * Read model for an item's OCR text: the latest extraction's status plus the
 * recognized text so the UI can show a spinner while it runs and the full text
 * once it lands.
 */
export const itemOcrResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  /** The recognized full text of the document, or null when not yet available. */
  text: z.string().nullable(),
  language: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemOcrResponse = z.infer<typeof itemOcrResponseSchema>;
