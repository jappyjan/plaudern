import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  ExtractionSegment,
  SpeakerTranscriptDto,
  SpeakerTranscriptSegmentDto,
  TranscriptSpeakerDto,
} from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import { ExtractedPayloadEntity, SpeakerOccurrenceEntity } from '@plaudern/persistence';

/** Total overlap in seconds between a window and a set of segments. */
export function overlapSeconds(
  start: number,
  end: number,
  segments: { start: number; end: number }[],
): number {
  let total = 0;
  for (const seg of segments) {
    total += Math.max(0, Math.min(end, seg.end) - Math.max(start, seg.start));
  }
  return total;
}

/**
 * Read-time merge of the latest transcription and diarization extractions
 * into one speaker-attributed transcript. Doing this at read time means job
 * ordering never matters and reprocessing either side "just works".
 */
@Injectable()
export class SpeakerTranscriptService {
  constructor(
    private readonly inbox: InboxService,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {}

  async getSpeakerTranscript(userId: string, inboxItemId: string): Promise<SpeakerTranscriptDto> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const transcription = latestOfKind(item.extractions ?? [], 'transcription');
    const diarization = latestOfKind(item.extractions ?? [], 'diarization');

    const text = transcription?.status === 'succeeded' ? transcription.content : null;

    let speakers: SpeakerTranscriptDto['speakers'] = [];
    let speakerByLabel = new Map<string, TranscriptSpeakerDto>();
    // Speakers redacted for consent are removed from `speakers`/`segments` and
    // surfaced separately so the UI can show (and undo) the redaction. Their
    // labels are dropped from segment attribution below (§ 201 StGB, ATT-663).
    const redactedSpeakers: TranscriptSpeakerDto[] = [];
    const redactedLabels = new Set<string>();
    if (diarization?.status === 'succeeded') {
      const rows = await this.occurrences.find({
        where: { extractionId: diarization.id },
        relations: { voiceProfile: true },
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      for (const row of rows) {
        const identity: TranscriptSpeakerDto = {
          profileId: row.voiceProfileId,
          name: row.voiceProfile.name,
          label: row.label,
          status: row.voiceProfile.status,
          isSelf: row.voiceProfile.isSelf,
          consentStatus: row.voiceProfile.consentStatus,
        };
        if (row.voiceProfile.redacted) {
          redactedLabels.add(row.label);
          redactedSpeakers.push(identity);
          continue;
        }
        speakers.push({
          ...identity,
          speakingSeconds: row.speakingSeconds,
          similarity: row.similarity,
        });
        speakerByLabel.set(row.label, identity);
      }
    }

    // A recording needs review when a still-present speaker has not consented.
    const needsConsentReview = speakers.some(
      (s) => s.consentStatus === 'unknown' || s.consentStatus === 'declined',
    );

    const canSegment =
      text !== null &&
      diarization?.status === 'succeeded' &&
      (transcription?.segments?.length ?? 0) > 0 &&
      (diarization.segments?.length ?? 0) > 0;

    if (canSegment) {
      const segments = attributeSegments(
        transcription!.segments!,
        diarization!.segments!,
        speakerByLabel,
        redactedLabels,
      );
      return {
        mode: 'segmented',
        text,
        segments,
        speakers,
        redactedSpeakers,
        needsConsentReview,
        diarizationStatus: diarization?.status ?? null,
      };
    }

    return {
      mode: text !== null ? 'flat' : 'none',
      text,
      segments: [],
      speakers,
      redactedSpeakers,
      needsConsentReview,
      diarizationStatus: diarization?.status ?? null,
    };
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

/**
 * Assign each transcript segment the diarized speaker with maximum temporal
 * overlap, then coalesce consecutive segments of the same speaker into one
 * display block.
 */
export function attributeSegments(
  transcriptSegments: ExtractionSegment[],
  diarizationSegments: ExtractionSegment[],
  speakerByLabel: Map<string, TranscriptSpeakerDto>,
  redactedLabels: Set<string> = new Set(),
): SpeakerTranscriptSegmentDto[] {
  const byLabel = new Map<string, { start: number; end: number }[]>();
  for (const seg of diarizationSegments) {
    if (!seg.speaker) continue;
    const list = byLabel.get(seg.speaker) ?? [];
    list.push({ start: seg.start, end: seg.end });
    byLabel.set(seg.speaker, list);
  }

  const attributed = transcriptSegments
    .map((seg) => {
      let bestLabel: string | null = null;
      let bestOverlap = 0;
      for (const [label, windows] of byLabel) {
        const overlap = overlapSeconds(seg.start, seg.end, windows);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestLabel = label;
        }
      }
      return {
        start: seg.start,
        end: seg.end,
        text: seg.text ?? '',
        speaker: bestLabel ? (speakerByLabel.get(bestLabel) ?? null) : null,
        redacted: bestLabel !== null && redactedLabels.has(bestLabel),
      };
    })
    // Drop segments spoken by a redacted speaker: their words leave the read model.
    .filter((seg) => !seg.redacted)
    .map(({ redacted: _redacted, ...seg }) => seg);

  const coalesced: SpeakerTranscriptSegmentDto[] = [];
  for (const seg of attributed) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.speaker?.profileId === seg.speaker?.profileId) {
      prev.end = seg.end;
      prev.text = joinText(prev.text, seg.text);
    } else {
      coalesced.push({ ...seg, text: seg.text.trim() });
    }
  }
  return coalesced;
}

function joinText(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}
