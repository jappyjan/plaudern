import { z } from 'zod';
import { extractionStatusSchema } from './inbox';
import { voiceProfileStatusSchema } from './speakers';

/**
 * The AI picks the layout that best fits the recording's content; the frontend
 * renders every layout the same way (markdown + mermaid + speaker mentions) but
 * shows the chosen layout as a small badge and the model is prompted to shape
 * the markdown to match (agenda/decisions for a meeting, Q&A for an interview,
 * a checklist for todos, …).
 */
export const summaryLayoutSchema = z.enum([
  'meeting',
  'interview',
  'lecture',
  'conversation',
  'note',
  'todo',
  'general',
]);
export type SummaryLayout = z.infer<typeof summaryLayoutSchema>;

/**
 * The persisted shape of a summary extraction's `content` (stored as JSON on
 * the append-only extracted_payloads row). Kept separate from the read model
 * below so storage and API can evolve independently.
 */
export const summaryPayloadSchema = z.object({
  title: z.string(),
  layout: summaryLayoutSchema,
  /** Markdown body. Speakers are mentioned as `@[SPEAKER_00]` tokens. */
  markdown: z.string(),
  model: z.string().nullable().optional(),
});
export type SummaryPayload = z.infer<typeof summaryPayloadSchema>;

/**
 * Roster entry the frontend uses to resolve `@[LABEL]` speaker mentions in the
 * summary markdown into clickable chips — mirrors the transcript's speaker
 * chips so a person looks and links the same everywhere.
 */
export const summarySpeakerSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().nullable(),
  label: z.string(),
  status: voiceProfileStatusSchema,
});
export type SummarySpeakerDto = z.infer<typeof summarySpeakerSchema>;

/**
 * Read model for the summary tab. `status` tracks the async pipeline step so
 * the UI can show a spinner while it runs and fall back to the transcript when
 * there is no summary yet. `speakers` lets `@[LABEL]` mentions resolve to the
 * same clickable people shown in the transcript.
 */
export const summarySchema = z.object({
  status: extractionStatusSchema.nullable(),
  title: z.string().nullable(),
  layout: summaryLayoutSchema.nullable(),
  markdown: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  speakers: z.array(summarySpeakerSchema),
});
export type SummaryDto = z.infer<typeof summarySchema>;
