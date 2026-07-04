import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Full-text-search support for hybrid search (JJ-38) — the keyword leg that
 * pairs with the pgvector semantic leg.
 *
 * We index `extracted_payloads.content` (the transcription and summary text)
 * rather than `embedding_chunks.text`. The keyword leg MUST keep working when
 * the embeddings provider is unconfigured — but in that deployment no
 * `embedding_chunks` rows are ever produced, so an FTS index over chunk text
 * would be permanently empty and the "degrade to keyword + filters" guarantee
 * would be hollow. The transcript/summary payloads exist independently of
 * embeddings, so indexing them keeps keyword search alive on its own.
 *
 * Config choice: `'simple'` (no stemming, no stopword removal, no language
 * dictionary). Jan's content is mixed German/English; a single-language stemmer
 * would mis-stem the other language, so `'simple'` — which just folds case and
 * splits on token boundaries — is the robust, predictable choice for bilingual
 * text. It is also strictly IMMUTABLE, which a `GENERATED ALWAYS ... STORED`
 * column requires. (Diacritic folding via `unaccent` was considered but skipped
 * on purpose: `unaccent` is only STABLE, so it cannot appear in a generated
 * column without an IMMUTABLE wrapper function plus the `unaccent` contrib
 * extension, and it would desync `ts_headline` highlighting from the stored
 * text. `'simple'` preserves umlauts identically on both the index and query
 * sides, so German terms match exactly. Diacritic-insensitive matching is a
 * documented future enhancement.)
 *
 * Additive and safe on existing installs: adds one generated column + a GIN
 * index; existing rows are backfilled by Postgres when the column is added.
 */
export class AddFullTextSearch1720000000026 implements MigrationInterface {
  name = 'AddFullTextSearch1720000000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "extracted_payloads"
      ADD COLUMN "search_vector" tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_extracted_payloads_search_vector" ON "extracted_payloads" USING gin ("search_vector")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_extracted_payloads_search_vector"`);
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN IF EXISTS "search_vector"`);
  }
}
