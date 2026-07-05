import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ExtractionSegment } from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import type { QuestionExtractionInput, QuestionSpeaker } from './questions.provider';

/** Fallback display name for an unnamed profile, mirroring the summary/web helper. */
function displayName(name: string | null, index: number): string {
  return name ?? `Speaker ${index + 1}`;
}

/** Upper bound on the transcript fed to the model so a long recording can't blow the context window. */
export const DEFAULT_MAX_CHARS = 12_000;

/**
 * Assembles the question-extraction input for an item from its append-only
 * extractions: the latest succeeded transcription merged with the latest
 * diarization into a speaker-attributed transcript, plus the speaker roster so
 * the model can attribute who asked whom. Reads speaker occurrences directly
 * (like the summary/commitments context) so the questions step stays
 * independent of @plaudern/speaker-id and @plaudern/summarization. Returns null
 * when there is no succeeded transcription to extract from.
 */
@Injectable()
export class QuestionContextService {
  constructor(
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {}

  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<QuestionExtractionInput | null> {
    const transcription = latestOfKind(item.extractions ?? [], 'transcription');
    const diarization = latestOfKind(item.extractions ?? [], 'diarization');

    if (transcription?.status !== 'succeeded' || !transcription.content) {
      return null;
    }

    const roster: { label: string; name: string | null }[] = [];
    // Redacted speakers (consent guardian) are kept out of the transcript
    // entirely, so a question is never attributed to someone who withdrew.
    const redactedLabels = new Set<string>();
    if (diarization?.status === 'succeeded') {
      const rows = await this.occurrences.find({
        where: { extractionId: diarization.id },
        relations: { voiceProfile: true },
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      for (const row of rows) {
        if (row.voiceProfile.redacted) {
          redactedLabels.add(row.label);
          continue;
        }
        roster.push({ label: row.label, name: row.voiceProfile.name });
      }
    }

    const speakerLabels = new Set(roster.map((s) => s.label));
    const transcript = buildTranscriptText(
      transcription.content,
      transcription.segments ?? null,
      diarization?.status === 'succeeded' ? diarization.segments ?? null : null,
      speakerLabels,
      redactedLabels,
    );

    const speakers: QuestionSpeaker[] = roster.map((s, index) => ({
      label: s.label,
      displayName: displayName(s.name, index),
    }));

    return {
      transcript: truncate(transcript, maxChars),
      speakers,
      // Owner voice is not identified today, so direction leans on first-person
      // language; the field is wired for when a self-profile lands.
      ownerLabel: null,
      language: transcription.language ?? undefined,
      occurredAt: iso(item.occurredAt),
    };
  }
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

/** Total overlap in seconds between a window and a set of segments. */
function overlapSeconds(
  start: number,
  end: number,
  windows: { start: number; end: number }[],
): number {
  let total = 0;
  for (const w of windows) {
    total += Math.max(0, Math.min(end, w.end) - Math.max(start, w.start));
  }
  return total;
}

/**
 * Produce the transcript text fed to the model. When both transcription and
 * diarization segments exist, prefix each coalesced block with its speaker
 * LABEL so the model can attribute questions; otherwise fall back to the plain
 * transcript text. Mirrors the summarization/commitments context builder.
 */
export function buildTranscriptText(
  content: string,
  transcriptSegments: ExtractionSegment[] | null,
  diarizationSegments: ExtractionSegment[] | null,
  speakerLabels: Set<string>,
  redactedLabels: Set<string> = new Set(),
): string {
  const canAttribute =
    (transcriptSegments?.length ?? 0) > 0 &&
    (diarizationSegments?.length ?? 0) > 0 &&
    (speakerLabels.size > 0 || redactedLabels.size > 0);
  if (!canAttribute) return content;

  const byLabel = new Map<string, { start: number; end: number }[]>();
  for (const seg of diarizationSegments!) {
    if (!seg.speaker) continue;
    const list = byLabel.get(seg.speaker) ?? [];
    list.push({ start: seg.start, end: seg.end });
    byLabel.set(seg.speaker, list);
  }

  const lines: { label: string | null; text: string }[] = [];
  for (const seg of transcriptSegments!) {
    let bestLabel: string | null = null;
    let bestOverlap = 0;
    for (const [label, windows] of byLabel) {
      const overlap = overlapSeconds(seg.start, seg.end, windows);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestLabel = label;
      }
    }
    if (bestLabel && redactedLabels.has(bestLabel)) continue;
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const prev = lines[lines.length - 1];
    if (prev && prev.label === bestLabel) {
      prev.text = `${prev.text} ${text}`.trim();
    } else {
      lines.push({ label: bestLabel, text });
    }
  }

  if (lines.length === 0) return content;
  return lines
    .map((line) => (line.label ? `${line.label}: ${line.text}` : line.text))
    .join('\n');
}
