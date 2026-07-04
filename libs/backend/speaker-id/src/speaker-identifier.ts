/**
 * The speaker-identification job/result shapes: given one recording, produce
 * its speaker-labeled segments AND link each speaker to a persistent voice
 * profile (writing speaker_occurrences as a side effect). Implemented by
 * PyannoteAiSpeakerIdentifier (hosted pyannoteAI API + voiceprint /identify).
 */
export interface SpeakerIdentificationJob {
  userId: string;
  inboxItemId: string;
  extractionId: string;
  /** Storage key of the recording's audio; the identifier uploads it as needed. */
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
