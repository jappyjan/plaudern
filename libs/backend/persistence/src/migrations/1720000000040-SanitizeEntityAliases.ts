import { MigrationInterface, QueryRunner } from 'typeorm';
import { sanitizeAliases } from '@plaudern/contracts';
import { EntityRegistryEntity } from '../entities';

/**
 * Cleans grammar out of already-persisted entity "Also known as" lists.
 *
 * The extractor emitted surface forms verbatim, so registry rows accumulated
 * closed-class function words ("Sie", "Ihre", "Ihrer") and generic role nouns
 * ("Patient", "der Arzt") as if they were personal aliases — the code paths
 * that wrote them are now filtered through `sanitizeAliases`, but the rows
 * written before that fix still carry the junk. This one-shot pass rewrites
 * every row's `aliases` through the same filter.
 *
 * Uses the EntityManager (not raw SQL) so it reads/writes through the
 * `aliases` `simple-json` transformer — array in, array out — on both Postgres
 * and sqlite. Idempotent: a row is only saved when its sanitized alias list
 * actually differs, so re-running is a no-op.
 */
export class SanitizeEntityAliases1720000000040 implements MigrationInterface {
  name = 'SanitizeEntityAliases1720000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const rows = await manager.find(EntityRegistryEntity);
    for (const row of rows) {
      const cleaned = sanitizeAliases(row.canonicalName, row.aliases ?? []);
      if (JSON.stringify(cleaned) === JSON.stringify(row.aliases ?? [])) continue;
      row.aliases = cleaned;
      await manager.save(row);
    }
  }

  public async down(): Promise<void> {
    // Irreversible: the discarded terms were never valid aliases and are not
    // recorded anywhere, so there is nothing to restore.
  }
}
