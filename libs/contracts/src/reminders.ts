import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `reminders` extraction kind (JJ-25) — "prospective-memory
 * events". An LLM reads a recording's transcript/summary (any text-bearing
 * source) and pulls out anything anchored to a FUTURE date — "the results
 * should be in by the 14th", "let's talk again next month", a contract expiry —
 * and each becomes a calendar-visible reminder automatically (VISION §5).
 *
 * A reminder carries a short title, the resolved absolute due date, the source
 * span it was drawn from (for provenance/citation), and the model's confidence.
 * Relative dates ("next month", "the 14th") are resolved against the SOURCE
 * recording's timestamp, not "now", so a recording processed weeks later still
 * lands the reminder on the date the speaker meant.
 *
 * A `reminders` row is user-scoped and MUTABLE only in `status`: `active` is
 * extraction-owned (a re-run reaps active rows it no longer stands behind);
 * `done` and `dismissed` are USER-owned states that a re-run never overwrites
 * and never reaps — the durability pattern copied from decisions/questions.
 * Deduped on (inboxItemId, dedupeKey=normalizedTitle|dueDay) so re-runs and
 * backfills upsert onto the same row instead of duplicating.
 */

/**
 * Lifecycle of a reminder. `active` = pending/upcoming (extraction-owned — a
 * re-run reaps active rows it no longer re-produces); `done` = the user marked
 * it handled; `dismissed` = the user dismissed it as irrelevant. `done` and
 * `dismissed` are USER-owned: a re-run never demotes them back to active and
 * never reaps them, mirroring the decisions durability rule.
 */
export const reminderStatusSchema = z.enum(['active', 'done', 'dismissed']);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

/**
 * One reminder as produced by the LLM, before its date is resolved + persisted.
 * `dueDate` is the model's best rendering of WHEN — an absolute ISO date when
 * it could compute one, or the raw phrase ("next month", "the 14th") which the
 * server resolves against the recording's timestamp. An entry whose date can't
 * be resolved to a future instant is dropped rather than stored.
 */
export const extractedReminderSchema = z.object({
  /** What the reminder is about, in a short phrase ("results are due", "contract expires"). */
  title: z.string().min(1),
  /**
   * WHEN, as the model rendered it: an absolute ISO date (YYYY-MM-DD) when the
   * model could resolve one, else the raw date phrase ("next month", "the
   * 14th") for the server to resolve against the recording's timestamp.
   */
  dueDate: z.string().min(1),
  /** The model's confidence that this is a real future-dated reminder (0..1), or null. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** The transcript span the reminder was drawn from, for provenance. */
  sourceQuote: z.string().nullable().default(null),
  /** Approximate segment start (seconds) the reminder was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable().default(null),
});
export type ExtractedReminder = z.infer<typeof extractedReminderSchema>;

/**
 * The persisted shape of a `reminders` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The resolved reminders live in
 * the `reminders` table; this is just the provenance the read model needs.
 */
export const reminderExtractionPayloadSchema = z.object({
  model: z.string(),
  /** How many reminder rows this extraction produced for the item. */
  reminderCount: z.number().int().nonnegative(),
});
export type ReminderExtractionPayload = z.infer<typeof reminderExtractionPayloadSchema>;

/** A resolved, persisted reminder as returned by the API. */
export const reminderSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  /** What the reminder is about. */
  title: z.string(),
  /** The resolved absolute instant the reminder is due (ISO). */
  dueAt: z.string().datetime(),
  status: reminderStatusSchema,
  /** The model's confidence in the reminder (0..1); null when not provided. */
  confidence: z.number().nullable(),
  /** Segment start (seconds into the recording) the reminder was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable(),
  /** The transcript span the reminder was drawn from; null when none captured. */
  sourceQuote: z.string().nullable(),
  /** When the source recording occurred (the anchor relative dates resolved against). */
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReminderDto = z.infer<typeof reminderSchema>;

/**
 * Read model for an item's reminders tab. `status` tracks the async pipeline
 * step so the UI can show a spinner while extraction runs and render nothing
 * when the item has not been processed yet.
 */
export const itemRemindersResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  reminders: z.array(reminderSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemRemindersResponse = z.infer<typeof itemRemindersResponseSchema>;

/**
 * Global reminders query: optionally filter by status and/or scope to a due
 * window ([from, to] ISO instants), so the calendar can fetch just the visible
 * range and an "upcoming" view can request everything still `active`.
 */
export const reminderListQuerySchema = z.object({
  status: reminderStatusSchema.optional(),
  /** Inclusive lower bound on dueAt (ISO); reminders due before it are excluded. */
  from: z.string().datetime().optional(),
  /** Inclusive upper bound on dueAt (ISO); reminders due after it are excluded. */
  to: z.string().datetime().optional(),
});
export type ReminderListQuery = z.infer<typeof reminderListQuerySchema>;

export const reminderListResponseSchema = z.object({
  reminders: z.array(reminderSchema),
});
export type ReminderListResponse = z.infer<typeof reminderListResponseSchema>;

/** Advance a reminder's lifecycle status (active → done / dismissed, or reopen). */
export const updateReminderStatusRequestSchema = z.object({
  status: reminderStatusSchema,
});
export type UpdateReminderStatusRequest = z.infer<typeof updateReminderStatusRequestSchema>;
