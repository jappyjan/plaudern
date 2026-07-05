import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { ExtractedReminder } from '@plaudern/contracts';
import { ReminderEntity } from '@plaudern/persistence';
import { resolveDueAt } from './reminder-date';

/** Caps on model output so one recording can't flood the table or store huge strings. */
const MAX_REMINDERS_PER_ITEM = 50;
const MAX_TITLE_CHARS = 300;
const MAX_QUOTE_CHARS = 1_000;

/**
 * Persists one extraction's batch of reminders into the user-scoped `reminders`
 * table. Each entry's date is resolved against the recording's `occurredAt`
 * (NOT "now") via `resolveDueAt`; entries whose date can't be resolved to a
 * future instant are SKIPPED, never stored. Upserts on
 * (inboxItemId, dedupeKey=normalizedTitle|dueDay).
 *
 * Status semantics — `active` is extraction-owned; `done` and `dismissed` are
 * USER-owned. A re-run repoints an existing row's provenance and refreshes its
 * fields but the UPDATE path OMITS `status`, so a user's edit is never
 * clobbered when the LLM re-emits the row; and only rows still `active` that an
 * earlier extraction produced and this batch did NOT re-produce are reaped —
 * done/dismissed rows are kept as a record, mirroring the decisions rule.
 *
 * Lives in its OWN provider (not RemindersService) so the dependency graph
 * stays acyclic: RemindersService → REMINDERS_QUEUE → RemindersProcessor →
 * RemindersPersistenceService, with no edge back to the service.
 */
@Injectable()
export class RemindersPersistenceService {
  constructor(
    @InjectRepository(ReminderEntity)
    private readonly reminders: Repository<ReminderEntity>,
  ) {}

  /**
   * Persist a batch of extracted reminders for an item. Resolves each date
   * against `occurredAt`, dedupes + upserts on (inboxItemId, dedupeKey): a
   * re-run refreshes the existing row's fields + provenance but PRESERVES a
   * user-owned status (`done`/`dismissed`). Rows an earlier extraction produced
   * that the new batch did NOT re-produce are reaped only while still `active`.
   * Returns the number of rows touched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    occurredAt: string,
    extracted: ExtractedReminder[],
  ): Promise<number> {
    // Resolve dates, drop unparseable/past ones, collapse in-batch duplicates
    // (same title on the same due day), and clamp adversarial/verbose output.
    const byKey = new Map<string, { fields: ReminderFields; dedupeKey: string }>();
    for (const raw of extracted) {
      const title = clamp(raw.title, MAX_TITLE_CHARS);
      if (!title) continue;
      const dueAt = resolveDueAt(raw.dueDate, occurredAt);
      if (!dueAt) continue; // unparseable or in the past — skip, never crash.
      const dueDay = dueAt.slice(0, 10);
      const dedupeKey = `${normalize(title)}|${dueDay}`;
      if (byKey.has(dedupeKey)) continue;
      byKey.set(dedupeKey, {
        dedupeKey,
        fields: {
          extractionId,
          title,
          dueAt,
          confidence: raw.confidence ?? null,
          sourceTimestamp: raw.sourceTimestamp ?? null,
          sourceQuote: raw.sourceQuote ? clamp(raw.sourceQuote, MAX_QUOTE_CHARS) : null,
        },
      });
      if (byKey.size >= MAX_REMINDERS_PER_ITEM) break;
    }

    let count = 0;
    // One transaction for the whole batch so a mid-loop failure can't leave the
    // item with a half-written reminder set.
    await this.reminders.manager.transaction(async (em) => {
      const repo = em.getRepository(ReminderEntity);
      for (const { dedupeKey, fields } of byKey.values()) {
        const existing = await repo.findOne({ where: { inboxItemId, dedupeKey } });
        if (existing) {
          // Refresh fields + provenance but NEVER touch a user-owned status
          // (`done`/`dismissed`) — those survive re-extraction.
          Object.assign(existing, fields);
          await repo.save(existing);
        } else {
          try {
            await repo.save(
              repo.create({ userId, inboxItemId, dedupeKey, status: 'active', ...fields }),
            );
          } catch (err) {
            // Lost a race on the unique index (concurrent worker/backfill) —
            // re-read the winner and update it instead of failing.
            if (!isUniqueViolation(err)) throw err;
            const winner = await repo.findOne({ where: { inboxItemId, dedupeKey } });
            if (!winner) throw err;
            Object.assign(winner, fields);
            await repo.save(winner);
          }
        }
        count += 1;
      }

      // Reap stale rows: every row this batch (re-)produced now points at the
      // new extractionId, so anything still on an older extraction was NOT
      // re-produced. Drop it only while still `active` (extraction-owned);
      // `done`/`dismissed` rows are user-owned and kept as a record.
      await repo.delete({
        inboxItemId,
        extractionId: Not(extractionId),
        status: 'active',
      });
    });
    return count;
  }
}

interface ReminderFields {
  extractionId: string;
  title: string;
  dueAt: string;
  confidence: number | null;
  sourceTimestamp: number | null;
  sourceQuote: string | null;
}

/** Normalization key: lowercased, whitespace-collapsed. */
export function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Trim + hard-cap a model-supplied string so stored values stay bounded. */
function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505, better-sqlite3 a SQLITE_CONSTRAINT* code /
 * "UNIQUE constraint failed" message. Anything else must propagate.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}
