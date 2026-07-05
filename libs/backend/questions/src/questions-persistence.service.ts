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
 * Status semantics — `open` is extraction-owned; `answered` is DURABLE once
 * set, whether by the user (PATCH) or by the model (answered=true): a re-run
 * may PROMOTE open → answered when the model reports the answer surfaced, but
 * it never demotes answered → open (that would re-nag a loop the user already
 * closed) and never touches `dropped` (the user's decision). Only rows still
 * `open` that an earlier extraction produced and this batch did NOT re-produce
 * are reaped — answered/dropped rows are kept as a record, mirroring the
 * commitments reaping rule (open-only).
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
   * row (repointing provenance to the new extraction) but PRESERVES settled
   * statuses — the only status transition a re-run may make on an existing row
   * is the safe promotion open → answered. Rows an earlier extraction produced
   * that the new batch did NOT re-produce are reaped only while still `open`.
   * NB: if a re-run PARAPHRASES a question the user already answered (different
   * normalizedQuestion), the old answered row is kept and a fresh open duplicate
   * appears — acceptable, mirrors the tasks duplicate-open behavior; the user
   * resolves it once more or drops it. Returns the number of rows touched.
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
          // The only status transition a re-run may make on an existing row is
          // the safe PROMOTION open → answered (the model saw the answer).
          // Never demote answered → open — `answered` is durable once set,
          // whether the user or a previous run set it — and never touch
          // `dropped` (the user's decision).
          if (existing.status === 'open' && extractionStatus === 'answered') {
            existing.status = 'answered';
          }
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
            if (winner.status === 'open' && extractionStatus === 'answered') {
              winner.status = 'answered';
            }
            await repo.save(winner);
          }
        }
        count += 1;
      }

      // Reap stale rows: every row this batch (re-)produced now points at the
      // new extractionId, so anything still on an older extraction was NOT
      // re-produced. Drop it only while still `open` (the model no longer
      // stands behind an unresolved loop); `answered` and `dropped` rows are
      // kept as a record of handled loops — answered is durable whether the
      // user or the model set it. Mirrors the commitments reaping rule.
      await repo.delete({
        inboxItemId,
        extractionId: Not(extractionId),
        status: 'open',
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
