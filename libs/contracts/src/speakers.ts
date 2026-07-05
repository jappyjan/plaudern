import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * A voice profile is a persistent "person" derived from voice embeddings.
 * Auto-created `unconfirmed` when a new voice is heard; the user confirms,
 * names, or merges it in the contact book.
 */
export const voiceProfileStatusSchema = z.enum(['unconfirmed', 'confirmed']);
export type VoiceProfileStatus = z.infer<typeof voiceProfileStatusSchema>;

/**
 * Recording-consent state for a person (§ 201 StGB guardian). `unknown` until
 * the user records whether this person knows they are being recorded;
 * `declined` means they did not consent and their speech should be kept out of
 * every read model (redacted, or the whole item deleted).
 */
export const consentStatusSchema = z.enum(['unknown', 'consented', 'declined']);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

export const voiceProfileSchema = z.object({
  id: z.string().uuid(),
  /** null => unnamed; the UI renders a placeholder like "Speaker N". */
  name: z.string().nullable(),
  status: voiceProfileStatusSchema,
  /** True when the user marked this contact as themselves (the account owner). */
  isSelf: z.boolean(),
  /** Whether this person consented to being recorded. */
  consentStatus: consentStatusSchema,
  /**
   * When true, this speaker's diarized segments are excluded from every read
   * model (transcripts, summaries, search). The immutable source is untouched.
   */
  redacted: z.boolean(),
  recordingCount: z.number().int().nonnegative(),
  totalSpeakingSeconds: z.number().nonnegative(),
  lastHeardAt: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type VoiceProfileDto = z.infer<typeof voiceProfileSchema>;

export const voiceProfileListResponseSchema = z.object({
  profiles: z.array(voiceProfileSchema),
});
export type VoiceProfileListResponse = z.infer<typeof voiceProfileListResponseSchema>;

/** One recording in which the profile's voice appears. */
export const voiceProfileRecordingSchema = z.object({
  inboxItemId: z.string().uuid(),
  occurredAt: z.string(),
  /** AI summary title, when one has been generated for the recording. */
  title: z.string().nullable(),
  /** Per-recording diarization label, e.g. SPEAKER_00. */
  label: z.string(),
  speakingSeconds: z.number().nonnegative(),
  /** null for the occurrence that created the profile. */
  similarity: z.number().nullable(),
});

export const voiceProfileDetailSchema = voiceProfileSchema.extend({
  recordings: z.array(voiceProfileRecordingSchema),
});
export type VoiceProfileDetailDto = z.infer<typeof voiceProfileDetailSchema>;

export const updateVoiceProfileRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Confirm-only; profiles cannot be un-confirmed. */
  status: z.literal('confirmed').optional(),
  /**
   * Mark (true) or unmark (false) this contact as the account owner ("me").
   * Setting it on one profile clears it on every other profile of the user.
   */
  isSelf: z.boolean().optional(),
  /** Record whether this person consented to being recorded. */
  consentStatus: consentStatusSchema.optional(),
  /** Toggle read-model redaction of this speaker's segments. */
  redacted: z.boolean().optional(),
});
export type UpdateVoiceProfileRequest = z.infer<typeof updateVoiceProfileRequestSchema>;

export const mergeVoiceProfilesRequestSchema = z.object({
  /** Merged INTO the profile addressed by the URL, then deleted. */
  sourceProfileId: z.string().uuid(),
});

/** Speaker identity attached to a transcript segment or chip. */
export const transcriptSpeakerSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().nullable(),
  label: z.string(),
  status: voiceProfileStatusSchema,
  /** True when this speaker is the account owner ("me"). */
  isSelf: z.boolean(),
  /** Recording-consent state, so the UI can prompt for unknown/declined voices. */
  consentStatus: consentStatusSchema,
});
export type TranscriptSpeakerDto = z.infer<typeof transcriptSpeakerSchema>;

export const speakerTranscriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  speaker: transcriptSpeakerSchema.nullable(),
});
export type SpeakerTranscriptSegmentDto = z.infer<typeof speakerTranscriptSegmentSchema>;

/**
 * Read model for the transcript UI: `segmented` when transcript timestamps and
 * diarization could be merged, `flat` when only plain text exists (speakers may
 * still be listed as chips), `none` when there is no transcript at all.
 */
export const speakerTranscriptSchema = z.object({
  mode: z.enum(['segmented', 'flat', 'none']),
  text: z.string().nullable(),
  segments: z.array(speakerTranscriptSegmentSchema),
  speakers: z.array(
    transcriptSpeakerSchema.extend({
      speakingSeconds: z.number().nonnegative(),
      similarity: z.number().nullable(),
    }),
  ),
  /**
   * Speakers whose segments were removed from this read model because they are
   * redacted. Listed separately (not in `speakers`/`segments`) so the UI can
   * show that redaction happened and offer to undo it.
   */
  redactedSpeakers: z.array(transcriptSpeakerSchema),
  /**
   * True when a listed (non-redacted) speaker has `unknown` or `declined`
   * consent — the recording needs a "does this person know they're being
   * recorded?" review.
   */
  needsConsentReview: z.boolean(),
  /** Latest diarization extraction status; lets the UI poll while in flight. */
  diarizationStatus: extractionStatusSchema.nullable(),
});
export type SpeakerTranscriptDto = z.infer<typeof speakerTranscriptSchema>;

/** Per-user consent-guardian policy settings. */
export const consentSettingsSchema = z.object({
  /**
   * When true, a recording is deleted whole as soon as diarization detects a
   * voice whose consent is `declined`. Enforced at the API layer (charter §1).
   */
  autoDeleteDeclined: z.boolean(),
});
export type ConsentSettingsDto = z.infer<typeof consentSettingsSchema>;

export const updateConsentSettingsRequestSchema = consentSettingsSchema;
export type UpdateConsentSettingsRequest = z.infer<typeof updateConsentSettingsRequestSchema>;
