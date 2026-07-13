import { z } from 'zod';

/**
 * User correction notes on an inbox item: free-text remarks ("the name is
 * 'Meier', not 'Maier'", "the amount was 1.500 €, the scan is misprinted")
 * that are fed into summary (re)generation as authoritative corrections.
 *
 * Notes are user-owned intelligence ABOUT a source, never part of it: the
 * source blob and its transcription/OCR rows stay untouched; only derived
 * read models (the summary, and whatever is computed from the summary)
 * reflect them. Works for every source type because every summarizable item
 * carries a transcription row (speech-to-text, typed-text passthrough, or the
 * OCR→transcription bridge for scanned documents).
 */
export const correctionNoteSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  createdAt: z.string().datetime(),
});
export type CorrectionNoteDto = z.infer<typeof correctionNoteSchema>;

export const correctionNoteListResponseSchema = z.object({
  notes: z.array(correctionNoteSchema),
});
export type CorrectionNoteListResponse = z.infer<typeof correctionNoteListResponseSchema>;

export const createCorrectionNoteRequestSchema = z.object({
  body: z.string().trim().min(1, 'note must not be empty').max(4000),
});
export type CreateCorrectionNoteRequest = z.infer<typeof createCorrectionNoteRequestSchema>;

/**
 * Result of adding or deleting a note: the refreshed list plus whether a
 * summary regeneration was queued. `summaryQueued` is false when summarization
 * is disabled, the item has nothing to summarize yet, or a summary is already
 * in flight — the notes still apply to whichever generation runs next.
 */
export const correctionNoteMutationResponseSchema = z.object({
  notes: z.array(correctionNoteSchema),
  summaryQueued: z.boolean(),
});
export type CorrectionNoteMutationResponse = z.infer<
  typeof correctionNoteMutationResponseSchema
>;
