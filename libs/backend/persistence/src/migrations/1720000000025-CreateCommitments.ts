import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Commitment extraction (JJ-36): a user-scoped `commitments` table holding
 * promissory obligations pulled from recordings in both directions — what the
 * owner owes (`owed_by_me`) and what others owe the owner (`owed_to_me`). Each
 * row carries the counterparty (raw name + optional registry entity link), the
 * obligation, an absolute `dueDate` resolved from relative language against the
 * recording time, a user-advanced `status`, and the source segment timestamp.
 *
 * Deduped on (inboxItemId, direction, normalizedDescription) so re-runs and
 * backfills upsert onto the same row (preserving the user's status) instead of
 * duplicating. Additive only — safe on existing installs.
 */
export class CreateCommitments1720000000025 implements MigrationInterface {
  name = 'CreateCommitments1720000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "commitments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "direction" character varying NOT NULL,
        "counterpartyName" character varying NOT NULL DEFAULT '',
        "counterpartyEntityId" uuid,
        "description" text NOT NULL,
        "normalizedDescription" character varying NOT NULL,
        "dueDate" character varying,
        "status" character varying NOT NULL DEFAULT 'open',
        "sourceTimestamp" double precision,
        "sourceQuote" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commitments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_commitments_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_commitments_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_commitments_userId" ON "commitments" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commitments_inboxItemId" ON "commitments" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commitments_user_direction_status" ON "commitments" ("userId", "direction", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_commitments_item_direction_desc" ON "commitments" ("inboxItemId", "direction", "normalizedDescription")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "commitments"`);
  }
}
