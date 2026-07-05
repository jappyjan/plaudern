import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { ExtractedQuestion } from '@plaudern/contracts';
import { EntityRegistryEntity, QuestionEntity } from '@plaudern/persistence';

/** Caps on model output so one recording can't flood the table or store huge strings. */
const MAX_QUESTIONS_PER_ITEM = 50;
const MAX_QUESTION_CHARS = 500;
const MAX_COUNTERPARTY_CHARS = 200;
const MAX_QUOTE_CHARS = 1_000;

/**
 * Persists one extraction's batch of questions into the user-scoped `questions`
 * table: links counterparties to registry `person` entities on a confident
 * name match, and upserts on (inboxItemId, direction, normalizedQuestion).
 *
 * Status semantics — `open`/`answered` are EXTRACTION-owned: they are re-derived
 * from the model on every run (a question the model now reports answered flips
 * to `answered`, and vice-versa), so a re-extraction keeps the resolved/unresolved
 * state honest. `dropped` is the ONLY user-owned status: once a user drops a
 * question the pipeline never resurrects it. Rows an earlier extraction produced
 * that this batch did NOT re-produce are reaped unless the user dropped them.
 *
 * Lives in its OWN provider (not QuestionsService) so the dependency graph
 * stays acyclic: QuestionsService → QUESTIONS_QUEUE → QuestionsProcessor →
 * QuestionsPersistenceService, with no edge back to the service — the
 * service→queue→processor→service cycle would deadlock Nest's module compile.
 */
@Injectable()
export class QuestionsPersistenceService {
  constructor(
    @InjectRepository(QuestionEntity)
    private readonly questions: Repository<QuestionEntity>,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
  ) {}

  /**
   * Persist a batch of extracted questions for an item. Deduped + upserted on
   * (inboxItemId, direction, normalizedQuestion): a re-run updates the existing
   * row (repointing provenance to the new extraction and refreshing the
   * extraction-owned open/answered status) but PRESERVES a user `dropped`
   * decision. Rows an earlier extraction produced that the new batch did NOT
   * re-produce are reaped unless the user dropped them. Returns the number of
   * rows touched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    extracted: ExtractedQuestion[],
  ): Promise<number> {
    // Collapse duplicates within the batch first (same direction + normalized
    // question), keeping the first occurrence, and clamp adversarial/verbose
    // model output so a single recording can't flood the table or store
    // unbounded strings.
    const byKey = new Map<string, ExtractedQuestion>();
    for (const raw of extracted) {
      const question = clamp(raw.question, MAX_QUESTION_CHARS);
      if (!question) continue;
      const key = `${raw.direction}:${normalize(question)}`;
      if (!byKey.has(key)) byKey.set(key, { ...raw, question });
      if (byKey.size >= MAX_QUESTIONS_PER_ITEM) break;
    }

    const personByName = byKey.size > 0 ? await this.personEntities(userId) : new Map();
    let count = 0;
    // One transaction for the whole batch so a mid-loop failure can't leave the
    // item with a half-written question set.
    await this.questions.manager.transaction(async (em) => {
      const repo = em.getRepository(QuestionEntity);
      for (const raw of byKey.values()) {
        const normalizedQuestion = normalize(raw.question);
        const counterpartyName = clamp(raw.counterparty, MAX_COUNTERPARTY_CHARS);
        const counterpartyEntityId = counterpartyName
          ? personByName.get(normalize(counterpartyName)) ?? null
          : null;
        const extractionStatus = raw.answered ? 'answered' : 'open';
        const fields = {
          extractionId,
          question: raw.question,
          counterpartyName,
          counterpartyEntityId,
          sourceTimestamp: raw.sourceTimestamp ?? null,
          sourceQuote: raw.sourceQuote ? clamp(raw.sourceQuote, MAX_QUOTE_CHARS) : null,
        };

        const existing = await repo.findOne({
          where: { inboxItemId, direction: raw.direction, normalizedQuestion },
        });
        if (existing) {
          Object.assign(existing, fields);
          // A user `dropped` decision is the user's alone — never resurrect it.
          // Otherwise refresh the extraction-owned open/answered status.
          if (existing.status !== 'dropped') existing.status = extractionStatus;
          await repo.save(existing);
        } else {
          try {
            await repo.save(
              repo.create({
                userId,
                inboxItemId,
                direction: raw.direction,
                normalizedQuestion,
                status: extractionStatus,
                ...fields,
              }),
            );
          } catch (err) {
            // Lost a race on the unique index (concurrent worker/backfill on the
            // same item) — re-read the winner and update it instead of failing.
            if (!isUniqueViolation(err)) throw err;
            const winner = await repo.findOne({
              where: { inboxItemId, direction: raw.direction, normalizedQuestion },
            });
            if (!winner) throw err;
            Object.assign(winner, fields);
            if (winner.status !== 'dropped') winner.status = extractionStatus;
            await repo.save(winner);
          }
        }
        count += 1;
      }

      // Reap stale rows: every row this batch (re-)produced now points at the
      // new extractionId, so anything still on an older extraction was NOT
      // re-produced. Drop it unless the user dropped it — a `dropped` row is a
      // user decision that must survive re-extraction; `open`/`answered` rows
      // are extraction-owned and vanish with the recording that no longer
      // supports them.
      await repo.delete({
        inboxItemId,
        extractionId: Not(extractionId),
        status: Not('dropped'),
      });
    });
    return count;
  }

  /** Named `person` registry entities keyed by normalized name, for linking. */
  private async personEntities(userId: string): Promise<Map<string, string>> {
    const rows = await this.entities.find({ where: { userId, type: 'person' } });
    const map = new Map<string, string>();
    for (const row of rows) {
      // First writer wins so linking is stable when two rows normalize alike.
      if (!map.has(row.normalizedName)) map.set(row.normalizedName, row.id);
    }
    return map;
  }
}

/** Normalization key: lowercased, whitespace-collapsed. Dedupe + name matching. */
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
