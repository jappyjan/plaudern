import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Same hard cap as the original `…026-AddFullTextSearch` migration — see that
 * file for why 500k chars keeps the generated tsvector safely under Postgres's
 * ~1MB limit.
 */
const MAX_INDEXED_CHARS = 500_000;

/**
 * Extend the hybrid-search keyword leg to OCR text (JJ-83). The
 * `…026-AddFullTextSearch` migration provisioned `extracted_payloads.search_vector`
 * as a GENERATED column over `kind IN ('transcription','summary')` only, so a
 * scanned document's `ocr` row produced a NULL vector and was invisible to
 * keyword search. Now that entities/embeddings/topics consume OCR text as a
 * first-class source, its content must be searchable too.
 *
 * A generated column's expression cannot be altered in place, so we drop the GIN
 * index + column and recreate them with `ocr` added to the CASE. Postgres
 * backfills the column for existing rows on ADD, so scanned documents already in
 * the vault become keyword-searchable without a separate backfill. Everything
 * else about the column (config `'simple'`, the `left(...)` size guard) is
 * unchanged. Additive and safe on existing installs.
 *
 * On the sqlite test database there is no generated column / FTS at all — the
 * keyword leg falls back to an in-JS scan that already reads the `ocr` kind — so
 * this migration is Postgres-only in effect.
 */
export class IndexOcrFullText1720000000050 implements MigrationInterface {
  name = 'IndexOcrFullText1720000000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_extracted_payloads_search_vector"`);
    await queryRunner.query(
      `ALTER TABLE "extracted_payloads" DROP COLUMN IF EXISTS "search_vector"`,
    );
    await queryRunner.query(`
      ALTER TABLE "extracted_payloads"
      ADD COLUMN "search_vector" tsvector
      GENERATED ALWAYS AS (
        CASE WHEN "kind" IN ('transcription', 'ocr', 'summary')
          THEN to_tsvector('simple', left(coalesce("content", ''), ${MAX_INDEXED_CHARS}))
          ELSE NULL
        END
      ) STORED
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_extracted_payloads_search_vector" ON "extracted_payloads" USING gin ("search_vector")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_extracted_payloads_search_vector"`);
    await queryRunner.query(
      `ALTER TABLE "extracted_payloads" DROP COLUMN IF EXISTS "search_vector"`,
    );
    await queryRunner.query(`
      ALTER TABLE "extracted_payloads"
      ADD COLUMN "search_vector" tsvector
      GENERATED ALWAYS AS (
        CASE WHEN "kind" IN ('transcription', 'summary')
          THEN to_tsvector('simple', left(coalesce("content", ''), ${MAX_INDEXED_CHARS}))
          ELSE NULL
        END
      ) STORED
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_extracted_payloads_search_vector" ON "extracted_payloads" USING gin ("search_vector")`,
    );
  }
}
