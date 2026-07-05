import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ItemSensitivityEntity } from '@plaudern/persistence';
import type { SentinelClassification } from './sentinel.classifier';

/**
 * Persists one item's sensitivity classification into `item_sensitivity`
 * (JJ-21). One row per item, upserted on `inboxItemId`.
 *
 * Two-owner split (mirrors the reminders status rule): `detectedTier`,
 * `detections`, `spans`, `llmClassified`, `extractionId` are EXTRACTION-owned
 * and refreshed on every re-run; `manualTier` is USER-owned and the UPDATE path
 * OMITS it, so a user's override is never clobbered by re-classification.
 * `held`/`heldReason` are routing state, owned by the extraction pipeline, so
 * they are left untouched here too.
 */
@Injectable()
export class SentinelPersistenceService {
  constructor(
    @InjectRepository(ItemSensitivityEntity)
    private readonly rows: Repository<ItemSensitivityEntity>,
  ) {}

  async upsert(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    classification: SentinelClassification,
  ): Promise<void> {
    const fields = {
      extractionId,
      detectedTier: classification.detectedTier,
      detections: classification.detections,
      spans: classification.spans,
      llmClassified: classification.llmClassified,
    };
    const existing = await this.rows.findOne({ where: { inboxItemId } });
    if (existing) {
      // Refresh the extraction-owned fields; NEVER touch manualTier / held.
      Object.assign(existing, fields);
      await this.rows.save(existing);
      return;
    }
    try {
      await this.rows.save(
        this.rows.create({ userId, inboxItemId, manualTier: null, held: false, ...fields }),
      );
    } catch (err) {
      // Lost the unique-index race with a concurrent worker — update the winner.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.rows.findOne({ where: { inboxItemId } });
      if (!winner) throw err;
      Object.assign(winner, fields);
      await this.rows.save(winner);
    }
  }
}

/** Unique-index violation across Postgres (23505) and better-sqlite3. */
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
