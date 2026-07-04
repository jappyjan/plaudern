import { MigrationInterface, QueryRunner } from 'typeorm';

/** Default matches `text-embedding-3-small`, the default provider model. */
const DEFAULT_DIMENSIONS = 1536;

/**
 * The `vector(N)` column dimension is fixed at migration time (an ANN index
 * needs a fixed dimension), so it is read from EMBEDDINGS_DIMENSIONS: operators
 * using a non-1536 model — e.g. keyless local Ollama with `nomic-embed-text`
 * (768) — must set it BEFORE the first run to get a matching column. Changing
 * the dimension after this migration ran requires a follow-up migration.
 */
function configuredDimensions(): number {
  const raw = process.env.EMBEDDINGS_DIMENSIONS;
  if (!raw) return DEFAULT_DIMENSIONS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`EMBEDDINGS_DIMENSIONS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Chunked vector embeddings of transcript + summary, stored in pgvector inside
 * the existing Postgres (no new database). Each chunk keeps its segment
 * timestamps so a retrieval hit can deep-link into the audio. Foundation for
 * semantic search, memory chat, dedupe and clustering (ATT-659).
 *
 * The `embedding` column dimension comes from EMBEDDINGS_DIMENSIONS (default
 * 1536 for `text-embedding-3-small`; 768 for Ollama's `nomic-embed-text`) and
 * is frozen once this migration runs. Additive only: safe on existing installs.
 *
 * NB: requires the `vector` extension — deploy with the `pgvector/pgvector`
 * Postgres image (docker-compose + Testcontainers use it).
 */
export class CreateEmbeddingChunks1720000000019 implements MigrationInterface {
  name = 'CreateEmbeddingChunks1720000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dimensions = configuredDimensions();
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`
      CREATE TABLE "embedding_chunks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "extractionId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "source" character varying NOT NULL,
        "chunkIndex" integer NOT NULL,
        "text" text NOT NULL,
        "startSeconds" double precision,
        "endSeconds" double precision,
        "model" character varying NOT NULL,
        "dimensions" integer NOT NULL,
        "embedding" vector(${dimensions}) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_embedding_chunks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_embedding_chunks_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_embedding_chunks_inboxItemId" ON "embedding_chunks" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_embedding_chunks_extractionId" ON "embedding_chunks" ("extractionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_embedding_chunks_userId" ON "embedding_chunks" ("userId")`,
    );
    // Approximate nearest-neighbour index for cosine distance (`<=>`).
    await queryRunner.query(
      `CREATE INDEX "IDX_embedding_chunks_vector" ON "embedding_chunks" USING hnsw ("embedding" vector_cosine_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "embedding_chunks"`);
    // Leave the `vector` extension in place — other objects may rely on it.
  }
}
