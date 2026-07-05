import { MigrationInterface, QueryRunner } from 'typeorm';

/** Default matches `text-embedding-3-small`, the default embeddings model. */
const DEFAULT_DIMENSIONS = 1536;

/**
 * The dedupe `vector(N)` column dimension is fixed at migration time (an ANN
 * index needs a fixed dimension), so it is read from EMBEDDINGS_DIMENSIONS — the
 * same knob the embedding-chunks migration reads. Operators on a non-1536 model
 * (e.g. keyless local Ollama `nomic-embed-text` at 768) must set it BEFORE the
 * first run; changing it afterwards requires a follow-up migration.
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
 * Task extraction with semantic dedupe (JJ-35). The `tasks` extractor pulls the
 * user's self-directed intentions from a recording's transcript/summary and
 * deduplicates them — SEMANTICALLY via the `embedding` vector when embeddings
 * are configured, otherwise on `normalizedTitle` — into per-user `tasks` rows.
 * Each recording that mentions a task adds a `task_citations` edge, so ten
 * mentions collapse into one task with ten citations.
 *
 * `tasks.embedding` is a nullable `vector(N)` (null when embeddings were not
 * configured at extraction time); the HNSW cosine index accelerates the dedupe
 * nearest-neighbour query and simply skips null rows. Additive only: safe on
 * existing installs.
 *
 * NB: the `vector` extension is provisioned by the embedding-chunks migration
 * (…019); `CREATE EXTENSION IF NOT EXISTS` here keeps this migration
 * self-standing.
 */
export class CreateTasks1720000000029 implements MigrationInterface {
  name = 'CreateTasks1720000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dimensions = configuredDimensions();
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`
      CREATE TABLE "tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "title" character varying NOT NULL,
        "normalizedTitle" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'open',
        "dueDate" character varying,
        "embedding" vector(${dimensions}),
        "embeddingModel" character varying,
        "embeddingDimensions" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tasks" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_userId" ON "tasks" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_user_status" ON "tasks" ("userId", "status")`,
    );
    // Concurrency guard for the dedupe (the bull queue runs 2 workers, and
    // multiple API instances may process items in parallel): at most ONE OPEN
    // task per (user, normalized title). A losing writer gets a unique
    // violation and re-reads the winner instead of creating a duplicate.
    // Partial (open only) so completing/dismissing a task frees the title for
    // a future fresh task.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_tasks_user_open_title" ON "tasks" ("userId", "normalizedTitle") WHERE status = 'open'`,
    );
    // Approximate nearest-neighbour index for cosine distance (`<=>`) — the
    // semantic-dedupe query. Null embeddings are skipped by the index.
    await queryRunner.query(
      `CREATE INDEX "IDX_tasks_embedding" ON "tasks" USING hnsw ("embedding" vector_cosine_ops)`,
    );

    await queryRunner.query(`
      CREATE TABLE "task_citations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "taskId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "quote" text,
        "startSeconds" double precision,
        "endSeconds" double precision,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_task_citations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_task_citations_task" FOREIGN KEY ("taskId")
          REFERENCES "tasks"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_task_citations_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_task_citations_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_task_citations_inboxItemId" ON "task_citations" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_task_citations_taskId" ON "task_citations" ("taskId")`,
    );
    // Idempotent ingestion: one citation per task per extraction, so a re-run or
    // backfill never duplicates citations.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_task_citations_extraction_task" ON "task_citations" ("extractionId", "taskId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "task_citations"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    // Leave the `vector` extension in place — other objects rely on it.
  }
}
