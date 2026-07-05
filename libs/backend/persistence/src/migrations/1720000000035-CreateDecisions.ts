import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Decision-log extraction (JJ-33): a user-scoped `decisions` table holding
 * decisions pulled from recordings — "we decided to go with the cheaper
 * option". Each row carries the decision statement, its context/reasoning, the
 * participants (raw name + optional registry entity link), the model's
 * confidence, a user-advanced `status` (active / revisited / superseded), and
 * the source segment timestamp for citation.
 *
 * Deduped on (inboxItemId, normalizedDecision) so re-runs and backfills upsert
 * onto the same row instead of duplicating (only still-active rows are reaped
 * on re-runs; revisited/superseded rows are user-owned and durable). Additive
 * only — safe on existing installs.
 */
export class CreateDecisions1720000000035 implements MigrationInterface {
  name = 'CreateDecisions1720000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "decisions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "decision" text NOT NULL,
        "normalizedDecision" character varying NOT NULL,
        "context" text,
        "participants" character varying NOT NULL DEFAULT '',
        "participantEntityId" uuid,
        "status" character varying NOT NULL DEFAULT 'active',
        "confidence" double precision,
        "sourceTimestamp" double precision,
        "sourceQuote" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_decisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_decisions_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_decisions_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_decisions_userId" ON "decisions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decisions_inboxItemId" ON "decisions" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decisions_user_status" ON "decisions" ("userId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_decisions_item_decision" ON "decisions" ("inboxItemId", "normalizedDecision")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "decisions"`);
  }
}
