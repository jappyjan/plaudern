import { z } from 'zod';
import { extractionStatusSchema } from './inbox';
import { voiceProfileStatusSchema } from './speakers';

/**
 * Preferred output language for AI summaries — a per-user setting applied to
 * every summarization. `auto` follows the recording's own (transcribed)
 * language; any other value forces that language regardless of what was spoken.
 */
export const summaryLanguagePreferenceSchema = z.enum([
  'auto',
  'en',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pt',
  'pl',
  'ru',
  'uk',
  'tr',
  'ja',
  'ko',
  'zh',
]);
export type SummaryLanguagePreference = z.infer<typeof summaryLanguagePreferenceSchema>;

/** English display/label per language code — also used to instruct the LLM. */
export const SUMMARY_LANGUAGE_LABELS: Record<SummaryLanguagePreference, string> = {
  auto: 'Automatic (match the recording)',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

/** Per-user summarization preferences. */
export const summarizationSettingsSchema = z.object({
  language: summaryLanguagePreferenceSchema,
});
export type SummarizationSettingsDto = z.infer<typeof summarizationSettingsSchema>;

export const updateSummarizationSettingsRequestSchema = summarizationSettingsSchema;
export type UpdateSummarizationSettingsRequest = z.infer<
  typeof updateSummarizationSettingsRequestSchema
>;

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
