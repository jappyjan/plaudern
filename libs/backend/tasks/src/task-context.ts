import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { summaryPayloadSchema } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { SpeakerOccurrenceEntity } from '@plaudern/persistence';
import { SelfProfileService } from '@plaudern/inbox';
import type { TaskExtractionInput, TaskSpeaker } from './tasks.provider';

/** Upper bound on the analyzed text so a long transcript can't blow the context window. */
export const DEFAULT_MAX_CHARS = 8_000;

/** Fallback display name for an unnamed profile, mirroring the summary/commitments helper. */
function displayName(name: string | null, index: number): string {
  return name ?? `Speaker ${index + 1}`;
}

/**
 * Outcome of assembling a task-extraction input:
 * - `ready`: run the model on `input`.
 * - `owner-absent`: the account owner ("me") could not be anchored for this item
 *   (no self profile, or a multi-speaker recording the owner did not speak in),
 *   so we must NOT guess whose tasks these are — the processor ingests zero
 *   tasks (superseding any stale ones) instead of failing.
 */
export type TaskContextResult =
  | { kind: 'ready'; input: TaskExtractionInput }
  | { kind: 'owner-absent' };

/**
 * Assembles the input a `tasks` extraction runs over. The text is the latest
 * succeeded summary (title + markdown — the densest signal for spotting
 * intentions), falling back to the raw transcription. On top of that it resolves
 * the account owner ("me") so the model extracts ONLY the owner's tasks, and
 * gates items where the owner cannot be anchored (see TaskContextResult).
 */
@Injectable()
export class TaskContextService {
  constructor(
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
    private readonly selfProfile: SelfProfileService,
  ) {}

  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<TaskContextResult | null> {
    const text = analyzedText(item, maxChars);
    if (!text) return null;

    // Whose tasks are these? Without an owner we don't guess.
    const self = await this.selfProfile.getSelf(item.userId);
    if (!self) return { kind: 'owner-absent' };

    const extractions = item.extractions ?? [];
    const diarization = latestOfKind(extractions, 'diarization');
    const roster: { label: string; name: string | null }[] = [];
    const ownerOccurrences: { label: string; voiceProfileId: string }[] = [];
    if (diarization?.status === 'succeeded') {
      const rows = await this.occurrences.find({
        where: { extractionId: diarization.id },
        relations: { voiceProfile: true },
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      for (const row of rows) {
        if (row.voiceProfile.redacted) continue;
        roster.push({ label: row.label, name: row.voiceProfile.name });
        ownerOccurrences.push({ label: row.label, voiceProfileId: row.voiceProfileId });
      }
    }

    const owner = this.selfProfile.resolveOwner(self, ownerOccurrences);
    // A diarized (multi-speaker) recording the owner did not speak in: we can't
    // tell which tasks are theirs, so don't guess — ingest nothing for this item.
    if (roster.length > 0 && owner.ownerLabel === null) return { kind: 'owner-absent' };

    const speakers: TaskSpeaker[] = roster.map((s, index) => ({
      label: s.label,
      displayName: displayName(s.name, index),
    }));

    const transcription = latestOfKind(extractions, 'transcription');
    return {
      kind: 'ready',
      input: {
        text,
        ownerName: owner.ownerName,
        ownerLabel: owner.ownerLabel,
        speakers,
        language: transcription?.language ?? undefined,
        occurredAt: iso(item.occurredAt),
      },
    };
  }
}

/** The text a tasks extraction analyzes: latest summary, else latest transcription. */
function analyzedText(item: InboxItemEntity, maxChars: number): string | null {
  const extractions = item.extractions ?? [];

  const summary = latestOfKind(extractions, 'summary');
  if (summary?.status === 'succeeded' && summary.content) {
    const text = summaryText(summary.content);
    if (text) return truncate(text, maxChars);
  }

  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content?.trim()) {
    return truncate(transcription.content.trim(), maxChars);
  }

  return null;
}

/** Flatten a stored summary payload (JSON) into prose. */
function summaryText(content: string): string {
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return '';
    const { title, markdown } = parsed.data;
    return [title, markdown].filter(Boolean).join('\n\n').trim();
  } catch {
    return '';
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
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
