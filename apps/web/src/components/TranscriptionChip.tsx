import { Chip } from '@heroui/react';
import type {
  ExtractedPayloadDto,
  ExtractionKind,
  ExtractionStatus,
  InboxItemDto,
} from '@plaudern/contracts';

const STATUS_COLOR: Record<ExtractionStatus, 'default' | 'secondary' | 'success' | 'danger'> = {
  queued: 'default',
  processing: 'secondary',
  succeeded: 'success',
  failed: 'danger',
};

/** The newest extraction of a kind; extractions arrive newest-first. */
function latestOfKind(item: InboxItemDto, kind: ExtractionKind): ExtractedPayloadDto | null {
  return item.extractions.find((extraction) => extraction.kind === kind) ?? null;
}

/** The newest transcription extraction. */
export function latestTranscription(item: InboxItemDto): ExtractedPayloadDto | null {
  return latestOfKind(item, 'transcription');
}

/** The newest diarization extraction, or null when speaker-id is disabled. */
export function latestDiarization(item: InboxItemDto): ExtractedPayloadDto | null {
  return latestOfKind(item, 'diarization');
}

export interface TranscriptionUnit {
  status: ExtractionStatus;
  transcription: ExtractedPayloadDto;
  diarization: ExtractedPayloadDto | null;
  /** The half whose failure sank the unit, if any (for an accurate message). */
  failure: ExtractedPayloadDto | null;
}

/**
 * Transcription and diarization are one product, not two: a bare transcript
 * with no speakers is worthless, so the two are surfaced as a single unit.
 *
 * The unit is `succeeded` only when BOTH halves succeed, `failed` once
 * everything has settled and either half failed, and otherwise still in flight
 * (`queued`/`processing`). Settling-before-failing means we never flash a
 * "failed" (with its reprocess button, which would 409) while the other half is
 * still running.
 *
 * Diarization is optional: with speaker-id disabled no diarization row is ever
 * appended, so the unit collapses to the transcription's own status.
 */
export function transcriptionUnit(item: InboxItemDto): TranscriptionUnit | null {
  const transcription = latestTranscription(item);
  if (!transcription) return null;
  const diarization = latestDiarization(item);
  const halves = diarization ? [transcription, diarization] : [transcription];

  const inFlight = halves.find((h) => h.status === 'queued' || h.status === 'processing');
  const failure = halves.find((h) => h.status === 'failed') ?? null;

  const status: ExtractionStatus = inFlight ? inFlight.status : failure ? 'failed' : 'succeeded';
  return { status, transcription, diarization, failure };
}

export function TranscriptionChip({ item }: { item: InboxItemDto }) {
  const unit = transcriptionUnit(item);
  if (!unit) return null;
  return (
    <Chip size="sm" variant="flat" color={STATUS_COLOR[unit.status]}>
      {unit.status === 'succeeded' ? 'transcribed' : unit.status}
    </Chip>
  );
}
