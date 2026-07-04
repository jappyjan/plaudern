import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * A voice profile is a persistent "person" derived from voice embeddings.
 * Auto-created `unconfirmed` when a new voice is heard; the user confirms,
 * names, or merges it in the contact book.
 */
export const voiceProfileStatusSchema = z.enum(['unconfirmed', 'confirmed']);
export type VoiceProfileStatus = z.infer<typeof voiceProfileStatusSchema>;

export const voiceProfileSchema = z.object({
  id: z.string().uuid(),
  /** null => unnamed; the UI renders a placeholder like "Speaker N". */
  name: z.string().nullable(),
  status: voiceProfileStatusSchema,
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
  /** Latest diarization extraction status; lets the UI poll while in flight. */
  diarizationStatus: extractionStatusSchema.nullable(),
});
export type SpeakerTranscriptDto = z.infer<typeof speakerTranscriptSchema>;
