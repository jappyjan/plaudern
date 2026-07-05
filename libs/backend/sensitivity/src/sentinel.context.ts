import { Injectable } from '@nestjs/common';
import { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { SentinelClassifyInput } from './sentinel.provider';

/** Upper bound on the transcript scanned, matching the reminders context cap. */
export const DEFAULT_MAX_CHARS = 20_000;

/**
 * Builds the sentinel classifier input from an item's latest succeeded
 * transcription — the same passthrough-friendly source the reminders extractor
 * reads (typed notes, emails and web snapshots all carry a passthrough
 * transcription row). Returns null when there is no succeeded transcription.
 */
@Injectable()
export class SentinelContextService {
  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<SentinelClassifyInput | null> {
    const transcription = latestOfKind(item.extractions ?? [], 'transcription');
    if (transcription?.status !== 'succeeded' || !transcription.content) {
      return null;
    }
    return {
      transcript: truncate(transcription.content, maxChars),
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
