/**
 * A speaker-identification strategy: given one recording, produce its
 * speaker-labeled segments AND link each speaker to a persistent voice profile
 * (writing speaker_occurrences as a side effect). Two implementations back the
 * two SPEAKER_ID_PROVIDER modes:
 *   - EmbeddingSpeakerIdentifier  (`pyannote`)   — local sidecar + cosine matching
 *   - PyannoteAiSpeakerIdentifier (`pyannoteai`) — hosted API + voiceprint /identify
 *
 * The DiarizationProcessor depends only on this seam, so it is agnostic to how
 * identity is computed.
 */
export interface SpeakerIdentificationJob {
  userId: string;
  inboxItemId: string;
  extractionId: string;
  /** Storage key of the recording's audio; the identifier presigns it as needed. */
  storageKey: string;
  contentType: string;
}

export interface SpeakerIdentificationResult {
  durationSeconds: number;
  /** Speaker-labeled segments; each label maps to one written speaker_occurrence. */
  segments: { start: number; end: number; speaker: string }[];
}

export interface SpeakerIdentifier {
  /** Stable id recorded as the extraction's `provider`. */
  readonly id: string;
  identify(job: SpeakerIdentificationJob): Promise<SpeakerIdentificationResult>;
}

export const SPEAKER_IDENTIFIER = Symbol('SPEAKER_IDENTIFIER');
