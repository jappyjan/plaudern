import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Living topic documents (JJ-12): an append-only per-topic table holding each
 * generated version of a topic's evergreen, self-updating Markdown document.
 * The current document is the highest-version succeeded row; older rows are the
 * visible version history. `citations` stores the structural source list the
 * body's inline `[n]` markers resolve against. Additive only — safe on existing
 * installs (the feature ships disabled until TOPIC_DOCS_API_KEY is set).
 *
 * NOTE ON TIMESTAMP: JJ-12 was pre-assigned migration 1720000000034, but that
 * timestamp was taken by AddCommitmentDuplicatesTask (merged after the ticket
 * was written) and 035 by a sibling in-flight branch (JJ-33). This migration
 * therefore uses the next free slot, 1720000000036, to honor the real
 * invariant: one timestamp per migration, no collisions.
 */
export class CreateTopicDocuments1720000000036 implements MigrationInterface {
  name = 'CreateTopicDocuments1720000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "topic_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "topicId" uuid NOT NULL,
        "version" integer NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "markdown" text,
        "citations" text,
        "sourceItemCount" integer NOT NULL DEFAULT 0,
        "model" character varying,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_documents" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_documents_userId" ON "topic_documents" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_documents_topicId" ON "topic_documents" ("topicId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_documents_topicId_status" ON "topic_documents" ("topicId", "status")`,
    );
    // One row per (topic, version): keeps version numbering consistent and lets
    // a racing concurrent generation recover from the unique violation.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_topic_documents_topicId_version" ON "topic_documents" ("topicId", "version")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "topic_documents"`);
  }
}
