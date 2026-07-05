import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { ExtractedCommitment } from '@plaudern/contracts';
import { CommitmentEntity, EntityRegistryEntity } from '@plaudern/persistence';
import { resolveDueDate } from './date-resolver';

/** Caps on model output so one recording can't flood the table or store huge strings. */
const MAX_COMMITMENTS_PER_ITEM = 50;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_COUNTERPARTY_CHARS = 200;
const MAX_QUOTE_CHARS = 1_000;

/**
 * Persists one extraction's batch of commitments into the user-scoped
 * `commitments` table: resolves relative due phrases to absolute instants
 * against the item's `occurredAt`, links counterparties to registry `person`
 * entities on a confident name match, and upserts on
 * (inboxItemId, direction, normalizedDescription).
 *
 * Lives in its OWN provider (not CommitmentsService) so the dependency graph
 * stays acyclic: CommitmentsService → COMMITMENTS_QUEUE → CommitmentsProcessor
 * → CommitmentsPersistenceService, with no edge back to the service — the
 * service-→queue→processor→service cycle would deadlock Nest's module compile.
 */
@Injectable()
export class CommitmentsPersistenceService {
  constructor(
    @InjectRepository(CommitmentEntity)
    private readonly commitments: Repository<CommitmentEntity>,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
  ) {}

  /**
   * Resolve + persist a batch of extracted commitments for an item. Deduped +
   * upserted on (inboxItemId, direction, normalizedDescription): a re-run
   * updates the existing row (repointing provenance to the new extraction) but
   * PRESERVES the user's status, so backfills never duplicate or reset
   * progress. Rows an earlier extraction produced that the new batch did NOT
   * re-produce are reaped when still `open` (the model no longer stands behind
   * them); rows the user already advanced (fulfilled/dismissed) are kept as a
   * record of handled obligations. Returns the number of rows touched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    occurredAt: string | undefined,
    extracted: ExtractedCommitment[],
  ): Promise<number> {
    // Collapse duplicates within the batch first (same direction + normalized
    // description), keeping the first occurrence, and clamp adversarial/verbose
    // model output so a single recording can't flood the table or store
    // unbounded strings.
    const byKey = new Map<string, ExtractedCommitment>();
    for (const raw of extracted) {
      const description = clamp(raw.description, MAX_DESCRIPTION_CHARS);
      if (!description) continue;
      const key = `${raw.direction}:${normalize(description)}`;
      if (!byKey.has(key)) byKey.set(key, { ...raw, description });
      if (byKey.size >= MAX_COMMITMENTS_PER_ITEM) break;
    }

    const personByName = byKey.size > 0 ? await this.personEntities(userId) : new Map();
    let count = 0;
    // One transaction for the whole batch so a mid-loop failure can't leave the
    // item with a half-written commitment set.
    await this.commitments.manager.transaction(async (em) => {
      const repo = em.getRepository(CommitmentEntity);
      for (const raw of byKey.values()) {
        const normalizedDescription = normalize(raw.description);
        const counterpartyName = clamp(raw.counterparty, MAX_COUNTERPARTY_CHARS);
        const counterpartyEntityId = counterpartyName
          ? personByName.get(normalize(counterpartyName)) ?? null
          : null;
        const dueIso = resolveDueDate(raw.duePhrase, occurredAt ?? null);
        const fields = {
          extractionId,
          description: raw.description,
          counterpartyName,
          counterpartyEntityId,
          dueDate: dueIso,
          sourceTimestamp: raw.sourceTimestamp ?? null,
          sourceQuote: raw.sourceQuote ? clamp(raw.sourceQuote, MAX_QUOTE_CHARS) : null,
        };

        const existing = await repo.findOne({
          where: { inboxItemId, direction: raw.direction, normalizedDescription },
        });
        if (existing) {
          // status is deliberately left untouched — it is the user's to advance.
          Object.assign(existing, fields);
          await repo.save(existing);
        } else {
          try {
            await repo.save(
              repo.create({
                userId,
                inboxItemId,
                direction: raw.direction,
                normalizedDescription,
                status: 'open',
                ...fields,
              }),
            );
          } catch (err) {
            // Lost a race on the unique index (concurrent worker/backfill on the
            // same item) — re-read the winner and update it instead of failing.
            if (!isUniqueViolation(err)) throw err;
            const winner = await repo.findOne({
              where: { inboxItemId, direction: raw.direction, normalizedDescription },
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
      // re-produced. Drop it while still `open` (the model no longer stands
      // behind it); keep user-advanced rows (fulfilled/dismissed) so handled
      // obligations never silently vanish from the record.
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
