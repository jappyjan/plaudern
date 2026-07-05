import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Auto-journal (JJ-17): every evening the day is composed from all its signals
 * (recordings/items with their summaries, calendar events) into a narrative
 * diary entry — a life journal without ever journaling. Weekly/monthly/yearly
 * reviews ("Your June") compose FROM the daily entries. Every statement carries
 * an inline `[n]` marker resolved against `citations`, exactly like the living
 * topic documents (JJ-12) and the memory chat, so the diary is fully traceable
 * back to its sources. Each generation is stored as a new version so a period's
 * write-up can evolve as more signals land without losing history.
 */

/** The four journal granularities. Rollups (week/month/year) compose from days. */
export const journalPeriodTypeSchema = z.enum(['day', 'week', 'month', 'year']);
export type JournalPeriodType = z.infer<typeof journalPeriodTypeSchema>;

/**
 * What a citation marker points at. `item` deep-links to an inbox item (a
 * recording and its extractions), `event` to a calendar event, and `journal`
 * back to a daily entry (how a monthly/weekly review links to the days it was
 * composed from).
 */
export const journalCitationKindSchema = z.enum(['item', 'event', 'journal']);
export type JournalCitationKind = z.infer<typeof journalCitationKindSchema>;

/**
 * One cited source of a journal entry. `marker` is the number the body
 * references as `[n]`. `refId` is the target the deep link opens — an inbox
 * item id (`item`), a calendar event id (`event`), or a daily period key like
 * `2026-06-14` (`journal`). `startSeconds` carries an audio offset for item
 * sources when known (null otherwise), mirroring the topic-document/chat
 * citation contract so the same renderer works.
 */
export const journalCitationSchema = z.object({
  marker: z.number().int().positive(),
  kind: journalCitationKindSchema,
  refId: z.string(),
  title: z.string().nullable(),
  occurredAt: z.string().datetime(),
  snippet: z.string().nullable(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
});
export type JournalCitation = z.infer<typeof journalCitationSchema>;

/** The persisted shape of a generation's `citations` column. */
export const journalCitationsPayloadSchema = z.array(journalCitationSchema);
export type JournalCitationsPayload = z.infer<typeof journalCitationsPayloadSchema>;

/**
 * Read model for one journal period (day/week/month/year). `status` is the
 * state of the most recent generation attempt (so the UI can show a spinner
 * while a fresh version is being written); `markdown`/`citations`/`version`
 * describe the current (latest succeeded) entry, which stays visible during a
 * regeneration and after a failed attempt. `enabled` is false when generation
 * is unconfigured, so the UI hides the feature instead of offering a dead
 * action.
 */
export const journalDocumentResponseSchema = z.object({
  periodType: journalPeriodTypeSchema,
  periodKey: z.string(),
  status: extractionStatusSchema.nullable(),
  version: z.number().int().positive().nullable(),
  markdown: z.string().nullable(),
  citations: z.array(journalCitationSchema),
  /**
   * Structural citation-coverage signal (JJ-20): `low` means enough of the
   * entry's claims lack a citation that the reader should treat it as "I think —
   * check the sources" rather than settled memory. Derived at read time from the
   * body's clause-level coverage; null when there is no succeeded entry yet.
   */
  confidence: z.enum(['high', 'low']).nullable(),
  sourceItemCount: z.number().int().nonnegative().nullable(),
  model: z.string().nullable(),
  /** Error of the most recent attempt when it failed; null otherwise. */
  error: z.string().nullable(),
  /** When the current (visible) entry was generated. */
  generatedAt: z.string().datetime().nullable(),
  /** When the most recent attempt (any status) was last touched. */
  updatedAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
});
export type JournalDocumentResponse = z.infer<typeof journalDocumentResponseSchema>;

/** One entry in the list of composed periods for a granularity (no body). */
export const journalPeriodSummarySchema = z.object({
  periodType: journalPeriodTypeSchema,
  periodKey: z.string(),
  version: z.number().int().positive(),
  sourceItemCount: z.number().int().nonnegative(),
  /** First line / heading-free lede of the entry, for the list preview. */
  preview: z.string().nullable(),
  generatedAt: z.string().datetime(),
});
export type JournalPeriodSummaryDto = z.infer<typeof journalPeriodSummarySchema>;

/** All composed entries for one granularity, newest period first. */
export const journalPeriodListResponseSchema = z.object({
  periodType: journalPeriodTypeSchema,
  periods: z.array(journalPeriodSummarySchema),
  enabled: z.boolean(),
});
export type JournalPeriodListResponse = z.infer<typeof journalPeriodListResponseSchema>;

/** One entry in a period's version history — metadata only (no body). */
export const journalVersionSchema = z.object({
  version: z.number().int().positive(),
  sourceItemCount: z.number().int().nonnegative(),
  model: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type JournalVersionDto = z.infer<typeof journalVersionSchema>;

export const journalVersionListResponseSchema = z.object({
  periodType: journalPeriodTypeSchema,
  periodKey: z.string(),
  /** Succeeded versions, newest first. */
  versions: z.array(journalVersionSchema),
});
export type JournalVersionListResponse = z.infer<typeof journalVersionListResponseSchema>;

/** A single historical version rendered in full — the body plus its citations. */
export const journalVersionDetailSchema = z.object({
  periodType: journalPeriodTypeSchema,
  periodKey: z.string(),
  version: z.number().int().positive(),
  markdown: z.string(),
  citations: z.array(journalCitationSchema),
  /** Clause-level citation-coverage signal for this version (JJ-20). */
  confidence: z.enum(['high', 'low']),
  sourceItemCount: z.number().int().nonnegative(),
  model: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type JournalVersionDetailDto = z.infer<typeof journalVersionDetailSchema>;
