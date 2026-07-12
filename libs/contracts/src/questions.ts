import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `questions` extraction kind (JJ-34): an LLM reads a
 * recording's speaker-attributed transcript and pulls out OPEN QUESTIONS — the
 * loops a bad memory drops silently — in BOTH directions:
 *
 *   - "Did you ever hear back from the landlord?" (I asked, nobody answered)
 *     → asked_by_me.
 *   - "Anna asked when I'd have the report ready" (asked OF me, I deferred)
 *     → asked_of_me.
 *
 * A question is only extracted when it went UNRESOLVED in the recording; if the
 * answer appears later in the same item the model marks it `answered` so the
 * user still sees the pair but it does not nag. Each question carries who/whom,
 * the question text, a user-advanceable status, and the source segment
 * timestamp so the user can jump to the exact moment in the audio.
 * Counterparties are linked to the per-user entity registry (person entities)
 * when a confident name match exists, else the raw name is kept — mirroring the
 * commitments extractor (JJ-36).
 */

/**
 * Which way a question points. `asked_by_me` = the owner asked it (waiting on
 * an answer from the counterparty); `asked_of_me` = the counterparty asked the
 * owner and the owner has not answered.
 */
export const questionDirectionSchema = z.enum(['asked_by_me', 'asked_of_me']);
export type QuestionDirection = z.infer<typeof questionDirectionSchema>;

/**
 * Lifecycle of a question. `open` = the loop is still dangling; `answered` =
 * resolved (either detected by the extractor when the answer appears later in
 * the same recording, or marked by the user); `dropped` = the user explicitly
 * let it go.
 *
 * Ownership: `open` is extraction-owned — a re-run reaps open rows it no
 * longer stands behind. `answered` is DURABLE once set, by user or model: a
 * re-run may promote open → answered but never demotes answered → open and
 * never reaps an answered row. `dropped` is user-owned: the pipeline never
 * overwrites or reaps it.
 */
export const questionStatusSchema = z.enum(['open', 'answered', 'dropped']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

/**
 * One question as produced by the LLM, before it is resolved + persisted.
 * `counterparty` is the other party's name as spoken (empty when the model
 * could not name them). `answered` is the model's judgment on whether the
 * question got an answer within the same recording.
 */
export const extractedQuestionSchema = z.object({
  direction: questionDirectionSchema,
  /**
   * The other party: for asked_by_me who I asked, for asked_of_me who asked
   * me. May be empty/unknown.
   */
  counterparty: z.string().default(''),
  /** The question itself, in a short phrase. */
  question: z.string().min(1),
  /**
   * Whether the answer surfaced later in the SAME recording. True → a new row
   * is persisted `answered` (kept for the record but not nagging) and an
   * existing open row is promoted to `answered`; false → a new row starts
   * `open`, but an existing `answered` row is never demoted back to open.
   */
  answered: z.boolean().default(false),
  /** The transcript span the question was drawn from, for provenance. */
  sourceQuote: z.string().nullable().default(null),
  /** Approximate segment start (seconds) the question was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable().default(null),
});
export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>;

/**
 * The persisted shape of a `questions` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The resolved questions live in
 * the `questions` table; this is just the provenance the read model needs
 * without a join.
 */
export const questionExtractionPayloadSchema = z.object({
  model: z.string(),
  /** How many question rows this extraction produced for the item. */
  questionCount: z.number().int().nonnegative(),
});
export type QuestionExtractionPayload = z.infer<typeof questionExtractionPayloadSchema>;

/** A resolved, persisted question as returned by the API. */
export const questionSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  direction: questionDirectionSchema,
  /** The other party's display name; empty string when unknown. */
  counterpartyName: z.string(),
  /** Linked registry person entity id when a confident match exists, else null. */
  counterpartyEntityId: z.string().uuid().nullable(),
  /** The question text. */
  question: z.string(),
  status: questionStatusSchema,
  /**
   * The recorded answer text (set by MCP answer_question); null when the
   * question was resolved without recorded text. User-owned — survives
   * re-extraction.
   */
  answer: z.string().nullable(),
  /** Segment start (seconds into the recording) the question was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable(),
  /** When the source recording occurred. */
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type QuestionDto = z.infer<typeof questionSchema>;

/**
 * Read model for an item's questions tab. `status` tracks the async pipeline
 * step so the UI can show a spinner while extraction runs and render nothing
 * when the item has not been processed yet.
 */
export const itemQuestionsResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  questions: z.array(questionSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemQuestionsResponse = z.infer<typeof itemQuestionsResponseSchema>;

/** Global questions list query: optionally filter by direction and/or status. */
export const questionListQuerySchema = z.object({
  direction: questionDirectionSchema.optional(),
  status: questionStatusSchema.optional(),
});
export type QuestionListQuery = z.infer<typeof questionListQuerySchema>;

export const questionListResponseSchema = z.object({
  questions: z.array(questionSchema),
});
export type QuestionListResponse = z.infer<typeof questionListResponseSchema>;

/** Advance a question's lifecycle status. */
export const updateQuestionStatusRequestSchema = z.object({
  status: questionStatusSchema,
});
export type UpdateQuestionStatusRequest = z.infer<typeof updateQuestionStatusRequestSchema>;
