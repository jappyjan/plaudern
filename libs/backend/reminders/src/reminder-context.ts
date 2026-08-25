import { Injectable } from '@nestjs/common';
import { resolveSourceText } from '@plaudern/inbox';
import { InboxItemEntity } from '@plaudern/persistence';
import type { ReminderExtractionInput } from './reminders.provider';

/** Upper bound on the transcript fed to the model so a long recording can't blow the context window. */
export const DEFAULT_MAX_CHARS = 12_000;

/**
 * Assembles the reminder-extraction input for an item from its append-only
 * extractions: the current source text plus the capture
 * timestamp (the anchor relative dates resolve against). Reminders only need
 * the words and WHEN they were said — not speaker attribution — so this reads
 * no other tables (unlike the decisions context), keeping the module light.
 * Any text-bearing source qualifies, including OCR documents. Returns null when
 * there is no nonblank succeeded source text.
 */
@Injectable()
export class ReminderContextService {
  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<ReminderExtractionInput | null> {
    const source = resolveSourceText(item);
    if (!source) return null;
    return {
      transcript: truncate(source.text, maxChars),
      language: source.language,
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
