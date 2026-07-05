import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { ExtractedDecision } from '@plaudern/contracts';
import { DecisionEntity, EntityRegistryEntity } from '@plaudern/persistence';

/** Caps on model output so one recording can't flood the table or store huge strings. */
const MAX_DECISIONS_PER_ITEM = 50;
const MAX_DECISION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_000;
const MAX_PARTICIPANTS_CHARS = 200;
const MAX_QUOTE_CHARS = 1_000;

/**
 * Persists one extraction's batch of decisions into the user-scoped `decisions`
 * table: links participants to registry `person` entities on a confident name
 * match, and upserts on (inboxItemId, normalizedDecision).
 *
 * Status semantics — `active` is extraction-owned; `revisited` and `superseded`
 * are USER-owned. A re-run repoints an existing row's provenance to the new
 * extraction and refreshes its fields but NEVER changes a user-owned status
 * back to `active`, and only rows still `active` that an earlier extraction
 * produced and this batch did NOT re-produce are reaped — revisited/superseded
 * rows are kept as a record, mirroring the questions reaping rule (open-only).
 *
 * Lives in its OWN provider (not DecisionsService) so the dependency graph
 * stays acyclic: DecisionsService → DECISIONS_QUEUE → DecisionsProcessor →
 * DecisionsPersistenceService, with no edge back to the service — the
 * service→queue→processor→service cycle would deadlock Nest's module compile.
 */
@Injectable()
export class DecisionsPersistenceService {
  constructor(
    @InjectRepository(DecisionEntity)
    private readonly decisions: Repository<DecisionEntity>,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
  ) {}

  /**
   * Persist a batch of extracted decisions for an item. Deduped + upserted on
   * (inboxItemId, normalizedDecision): a re-run updates the existing row
   * (repointing provenance to the new extraction) but PRESERVES a user-owned
   * status (`revisited`/`superseded`). Rows an earlier extraction produced that
   * the new batch did NOT re-produce are reaped only while still `active`.
   * Returns the number of rows touched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    extracted: ExtractedDecision[],
  ): Promise<number> {
    // Collapse duplicates within the batch first (same normalized decision),
    // keeping the first occurrence, and clamp adversarial/verbose model output
    // so a single recording can't flood the table or store unbounded strings.
    const byKey = new Map<string, ExtractedDecision>();
    for (const raw of extracted) {
      const decision = clamp(raw.decision, MAX_DECISION_CHARS);
      if (!decision) continue;
      const key = normalize(decision);
      if (!byKey.has(key)) byKey.set(key, { ...raw, decision });
      if (byKey.size >= MAX_DECISIONS_PER_ITEM) break;
    }

    const personByName = byKey.size > 0 ? await this.personEntities(userId) : new Map();
    let count = 0;
    // One transaction for the whole batch so a mid-loop failure can't leave the
    // item with a half-written decision set.
    await this.decisions.manager.transaction(async (em) => {
      const repo = em.getRepository(DecisionEntity);
      for (const raw of byKey.values()) {
        const normalizedDecision = normalize(raw.decision);
        const participants = clamp(raw.participants, MAX_PARTICIPANTS_CHARS);
        const participantEntityId = participants
          ? personByName.get(normalize(participants)) ?? null
          : null;
        const fields = {
          extractionId,
          decision: raw.decision,
          context: raw.context ? clamp(raw.context, MAX_CONTEXT_CHARS) : null,
          participants,
          participantEntityId,
          confidence: raw.confidence ?? null,
          sourceTimestamp: raw.sourceTimestamp ?? null,
          sourceQuote: raw.sourceQuote ? clamp(raw.sourceQuote, MAX_QUOTE_CHARS) : null,
        };

        const existing = await repo.findOne({
          where: { inboxItemId, normalizedDecision },
        });
        if (existing) {
          // Refresh fields + provenance but NEVER touch a user-owned status
          // (`revisited`/`superseded`) — those survive re-extraction.
          Object.assign(existing, fields);
          await repo.save(existing);
        } else {
          try {
            await repo.save(
              repo.create({
                userId,
                inboxItemId,
                normalizedDecision,
                status: 'active',
                ...fields,
              }),
            );
          } catch (err) {
            // Lost a race on the unique index (concurrent worker/backfill on the
            // same item) — re-read the winner and update it instead of failing.
            if (!isUniqueViolation(err)) throw err;
            const winner = await repo.findOne({
              where: { inboxItemId, normalizedDecision },
            });
            if (!winner) throw err;
            Object.assign(winner, fields);
            await repo.save(winner);
          }
        }
        count += 1;
      }

      // Reap stale rows: every row this batch (re-)produced now points at the
      // new extractionId, so anything still on an older extraction was NOT
      // re-produced. Drop it only while still `active` (the model no longer
      // stands behind it); `revisited`/`superseded` rows are user-owned and
      // kept as a record. Mirrors the questions reaping rule.
      await repo.delete({
        inboxItemId,
        extractionId: Not(extractionId),
        status: 'active',
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
