import { Injectable } from '@nestjs/common';
import { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { ReminderExtractionInput } from './reminders.provider';

/** Upper bound on the transcript fed to the model so a long recording can't blow the context window. */
export const DEFAULT_MAX_CHARS = 12_000;

/**
 * Assembles the reminder-extraction input for an item from its append-only
 * extractions: the latest succeeded transcription's text plus the recording
 * timestamp (the anchor relative dates resolve against). Reminders only need
 * the words and WHEN they were said — not speaker attribution — so this reads
 * no other tables (unlike the decisions context), keeping the module light.
 * Any text-bearing source qualifies: typed notes, emails and web snapshots all
 * carry a passthrough transcription row, so "future date in any source" is
 * covered. Returns null when there is no succeeded transcription.
 */
@Injectable()
export class ReminderContextService {
  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<ReminderExtractionInput | null> {
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
