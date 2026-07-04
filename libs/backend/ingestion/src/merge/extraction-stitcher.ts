import type { ExtractionSegment } from '@plaudern/contracts';

/**
 * One source recording's contribution to a merge, in playback order.
 * `offsetSeconds` is the sum of the durations of all earlier parts.
 */
export interface MergePart {
  itemId: string;
  offsetSeconds: number;
  transcription?: {
    content: string | null;
    segments: ExtractionSegment[] | null;
    language: string | null;
  };
  diarization?: {
    segments: ExtractionSegment[] | null;
  };
  /** Speaker occurrences of the part's diarization extraction. */
  occurrences: { label: string; voiceProfileId: string }[];
}

export interface StitchedTranscription {
  content: string;
  segments: ExtractionSegment[];
  language: string | null;
}

export interface StitchedDiarization {
  segments: ExtractionSegment[];
  /** One row per merged label that maps to a real voice profile. */
  occurrences: { label: string; voiceProfileId: string; speakingSeconds: number }[];
}

/**
 * Combine per-part transcriptions into one: contents joined with a blank
 * line, segments shifted onto the merged timeline. Parts without segments
 * still contribute their text (the transcript read path degrades to flat
 * mode). Language is kept only when all parts that declare one agree.
 */
export function stitchTranscriptions(parts: MergePart[]): StitchedTranscription {
  const content = parts
    .map((part) => part.transcription?.content?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');

  const segments = parts.flatMap((part) =>
    (part.transcription?.segments ?? []).map((segment) => ({
      ...segment,
      start: segment.start + part.offsetSeconds,
      end: segment.end + part.offsetSeconds,
    })),
  );

  const languages = new Set(
    parts.map((part) => part.transcription?.language).filter((l): l is string => Boolean(l)),
  );
  const language = languages.size === 1 ? [...languages][0] : null;

  return { content, segments, language };
}

/**
 * Combine per-part diarizations into one. Per-recording labels (SPEAKER_00,
 * ...) collide across recordings, so speakers are re-identified by the voice
 * profile behind each label: the same profile appearing in several parts
 * collapses onto ONE merged label, while distinct profiles get distinct
 * labels, assigned SPEAKER_00/01/... in order of first appearance on the
 * merged timeline.
 *
 * A part label without an occurrence (matcher failed after segments landed,
 * or the profile was deleted) keeps a part-local identity: its segments are
 * still relabeled consistently, but no merged occurrence row is produced —
 * the transcript read path renders such labels as "unknown speaker".
 */
export function stitchDiarizations(parts: MergePart[]): StitchedDiarization {
  const labelByIdentity = new Map<string, string>();
  const profileByIdentity = new Map<string, string>();
  const speakingSecondsByIdentity = new Map<string, number>();

  const identityOf = (part: MergePart, label: string): string => {
    const profileId = part.occurrences.find((o) => o.label === label)?.voiceProfileId;
    return profileId ?? `local:${part.itemId}:${label}`;
  };

  const segments: ExtractionSegment[] = [];
  for (const part of parts) {
    const partSegments = (part.diarization?.segments ?? [])
      .slice()
      .sort((a, b) => a.start - b.start);
    for (const segment of partSegments) {
      if (!segment.speaker) continue;
      const identity = identityOf(part, segment.speaker);
      let label = labelByIdentity.get(identity);
      if (!label) {
        label = `SPEAKER_${String(labelByIdentity.size).padStart(2, '0')}`;
        labelByIdentity.set(identity, label);
        const profileId = part.occurrences.find((o) => o.label === segment.speaker)
          ?.voiceProfileId;
        if (profileId) profileByIdentity.set(identity, profileId);
      }
      speakingSecondsByIdentity.set(
        identity,
        (speakingSecondsByIdentity.get(identity) ?? 0) + Math.max(0, segment.end - segment.start),
      );
      segments.push({
        start: segment.start + part.offsetSeconds,
        end: segment.end + part.offsetSeconds,
        speaker: label,
      });
    }
  }

  const occurrences = [...profileByIdentity.entries()].map(([identity, voiceProfileId]) => ({
    label: labelByIdentity.get(identity)!,
    voiceProfileId,
    speakingSeconds: speakingSecondsByIdentity.get(identity) ?? 0,
  }));

  return { segments, occurrences };
}
