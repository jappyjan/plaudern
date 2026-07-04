import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hard cap (in characters) on the content fed to to_tsvector. Postgres rejects
 * any tsvector larger than ~1MB (1048575 bytes) — and that budget is consumed
 * by lexemes PLUS their position lists, which for natural language can weigh
 * as much as the raw text; multi-byte UTF-8 (German umlauts) inflates it
 * further. An unguarded expression would (a) fail the ALTER TABLE backfill on
 * any existing long transcript, blocking the deploy at the migration gate, and
 * (b) fail every future INSERT of a long transcription payload forever —
 * bricking ingestion of multi-hour recordings. 500k chars keeps the worst case
 * comfortably under the limit (position lists are capped at 256 entries per
 * lexeme and 'simple' dedups repeated words, so the tsvector of 500k chars of
 * speech lands far below 1MB) while still indexing roughly 8+ hours of spoken
 * transcript; text beyond the cap simply isn't keyword-searchable (the
 * semantic leg still covers it chunk-by-chunk). left() is IMMUTABLE, so it is
 * valid inside a generated column.
 */
const MAX_INDEXED_CHARS = 500_000;

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
 * The expression is scoped to kind IN ('transcription','summary') — exactly
 * the kinds the keyword leg queries. Other extraction kinds store JSON blobs
 * (topics, entities, embedding provenance) and future kinds (tasks,
 * commitments) land in this same table; indexing them would waste GIN space on
 * JSON syntax tokens and extend the tsvector-size blast radius to every kind
 * ever added. CASE + IMMUTABLE functions is valid in a generated column, and
 * NULL rows cost nothing in the GIN index.
 *
 * Known relevance nit, accepted deliberately: summary `content` is a JSON
 * envelope (title/layout/markdown), so FTS tokenizes its keys/syntax along
 * with the prose. Extracting the fields would require a jsonb cast, and
 * `text::jsonb` THROWS on malformed JSON — inside a generated column that
 * would brick the INSERT of any malformed summary row. Ingestion safety wins:
 * the JSON keys are a handful of constant tokens that virtually never collide
 * with real queries.
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_extracted_payloads_search_vector"`);
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN IF EXISTS "search_vector"`);
  }
}
