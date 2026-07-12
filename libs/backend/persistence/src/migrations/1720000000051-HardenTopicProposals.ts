import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Taxonomy-proposals hardening (JJ-69, follow-up to JJ-64). Four additive,
 * install-safe changes bundled into one migration:
 *
 *  1. `topic_proposal_runs` — one row per user tracking the async generation
 *     run's status (generation moved off the request path onto the queue/worker
 *     so a slow multi-cluster labeling pass can't time out behind a proxy). The
 *     unique `userId` index makes the row the race-safe double-click guard.
 *  2. `topic_proposals.centroid` — the cluster's stored mean embedding, so a
 *     dismissed cluster that regrew can be suppressed by centroid cosine even
 *     when member-id Jaccard no longer matches. Nullable: legacy rows fall back
 *     to Jaccard-only suppression.
 *  3. Retention index `(userId, status, createdAt)` on `topic_proposals` — backs
 *     the bounded "newest N resolved rows per user" suppression query and prune,
 *     replacing the old "load ALL of a user's rows" scan.
 *  4. FK `acceptedTopicId -> topics(id) ON DELETE SET NULL` — deleting an
 *     accepted topic clears the reference instead of leaving a dangling id.
 *     Existing dangling references are NULLed first so the constraint validates.
 */
export class HardenTopicProposals1720000000051 implements MigrationInterface {
  name = 'HardenTopicProposals1720000000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Async generation-run status (one row per user).
    await queryRunner.query(`
      CREATE TABLE "topic_proposal_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "error" text,
        "proposalsCreated" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_proposal_runs" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_topic_proposal_runs_userId" ON "topic_proposal_runs" ("userId")`,
    );

    // 2. Stored cluster centroid for centroid-based suppression of regrown
    //    dismissed clusters. Nullable — legacy rows are Jaccard-only.
    await queryRunner.query(`ALTER TABLE "topic_proposals" ADD COLUMN "centroid" text`);

    // 3. Retention/suppression query index.
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_proposals_userId_status_createdAt" ON "topic_proposals" ("userId", "status", "createdAt")`,
    );

    // 4. FK on acceptedTopicId with ON DELETE SET NULL. NULL any pre-existing
    //    dangling references first so ADD CONSTRAINT validates on existing data.
    await queryRunner.query(
      `UPDATE "topic_proposals" SET "acceptedTopicId" = NULL
       WHERE "acceptedTopicId" IS NOT NULL
         AND "acceptedTopicId" NOT IN (SELECT "id" FROM "topics")`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_proposals"
       ADD CONSTRAINT "FK_topic_proposals_acceptedTopic"
       FOREIGN KEY ("acceptedTopicId") REFERENCES "topics"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_proposals" DROP CONSTRAINT "FK_topic_proposals_acceptedTopic"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_topic_proposals_userId_status_createdAt"`);
    await queryRunner.query(`ALTER TABLE "topic_proposals" DROP COLUMN "centroid"`);
    await queryRunner.query(`DROP TABLE "topic_proposal_runs"`);
  }
}
