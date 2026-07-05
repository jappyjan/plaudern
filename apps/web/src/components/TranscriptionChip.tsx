import { Chip } from '@heroui/react';
import { isAudioBearing, type ExtractionStatus, type InboxItemDto } from '@plaudern/contracts';

const STATUS_COLOR: Record<ExtractionStatus, 'default' | 'secondary' | 'success' | 'danger'> = {
  queued: 'default',
  processing: 'secondary',
  succeeded: 'success',
  failed: 'danger',
};

/** The newest transcription extraction; extractions arrive newest-first. */
export function latestTranscription(item: InboxItemDto) {
  return item.extractions.find((extraction) => extraction.kind === 'transcription') ?? null;
}

export function TranscriptionChip({ item }: { item: InboxItemDto }) {
  // Text-bearing items get a passthrough transcription row (their own body),
  // so a "transcribed" chip would be misleading — the chip is audio-only.
  if (!isAudioBearing(item.sourceType)) return null;
  const transcription = latestTranscription(item);
  if (!transcription) return null;
  return (
    <Chip size="sm" variant="flat" color={STATUS_COLOR[transcription.status]}>
      {transcription.status === 'succeeded' ? 'transcribed' : transcription.status}
    </Chip>
  );
}
