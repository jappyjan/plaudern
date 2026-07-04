import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ExtractionSegment, SummarySpeakerDto } from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import type { SummarizationInput, SummarizationSpeaker } from './summarization.provider';

/** Fallback display name for an unnamed profile, mirroring the web helper. */
function displayName(name: string | null, index: number): string {
  return name ?? `Speaker ${index + 1}`;
}

export interface SummaryContext {
  /** null when there is no succeeded transcription to summarize. */
  input: SummarizationInput | null;
  /** Roster for resolving `@[LABEL]` mentions in the stored markdown. */
  speakers: SummarySpeakerDto[];
}

/**
 * Assembles what the summarizer (and the summary read model) needs from an
 * item's append-only extractions: the latest transcription, merged with the
 * latest diarization into a speaker-attributed transcript, plus the speaker
 * roster. Kept independent of @plaudern/speaker-id (reading occurrences
 * directly) so the summarization step does not depend on that module.
 */
@Injectable()
export class SummaryContextService {
  constructor(
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {}

  async build(item: InboxItemEntity): Promise<SummaryContext> {
    const transcription = latestOfKind(item.extractions ?? [], 'transcription');
    const diarization = latestOfKind(item.extractions ?? [], 'diarization');

    if (transcription?.status !== 'succeeded' || !transcription.content) {
      return { input: null, speakers: [] };
    }

    let roster: SummarySpeakerDto[] = [];
    if (diarization?.status === 'succeeded') {
      const rows = await this.occurrences.find({
        where: { extractionId: diarization.id },
        relations: { voiceProfile: true },
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      roster = rows.map((row) => ({
        profileId: row.voiceProfileId,
        name: row.voiceProfile.name,
        label: row.label,
        status: row.voiceProfile.status,
      }));
    }

    const speakerByLabel = new Map(roster.map((s) => [s.label, s]));
    const transcript = buildTranscriptText(
      transcription.content,
      transcription.segments ?? null,
      diarization?.status === 'succeeded' ? diarization.segments ?? null : null,
      speakerByLabel,
    );

    const speakers: SummarizationSpeaker[] = roster.map((s, index) => ({
      label: s.label,
      displayName: displayName(s.name, index),
      confirmed: s.status === 'confirmed',
    }));

    return {
      input: {
        transcript,
        speakers,
        language: transcription.language ?? undefined,
        occurredAt: iso(item.occurredAt),
        durationSeconds: maxSegmentEnd(transcription.segments ?? null),
      },
      speakers: roster,
    };
  }
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
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

function maxSegmentEnd(segments: ExtractionSegment[] | null): number | undefined {
  if (!segments || segments.length === 0) return undefined;
  return segments.reduce((max, s) => Math.max(max, s.end), 0);
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
 * LABEL so the model can attribute statements; otherwise fall back to the plain
 * transcript text.
 */
export function buildTranscriptText(
  content: string,
  transcriptSegments: ExtractionSegment[] | null,
  diarizationSegments: ExtractionSegment[] | null,
  speakerByLabel: Map<string, { label: string }>,
): string {
  const canAttribute =
    (transcriptSegments?.length ?? 0) > 0 &&
    (diarizationSegments?.length ?? 0) > 0 &&
    speakerByLabel.size > 0;
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
