import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Open-question extraction (JJ-34): a user-scoped `questions` table holding
 * unanswered questions pulled from recordings in both directions — questions
 * the owner asked that got no answer (`asked_by_me`) and questions asked of the
 * owner that they deferred (`asked_of_me`). Each row carries the counterparty
 * (raw name + optional registry entity link), the question, a user-advanced
 * `status` (open / answered / dropped), and the source segment timestamp.
 *
 * Deduped on (inboxItemId, direction, normalizedQuestion) so re-runs and
 * backfills upsert onto the same row instead of duplicating. Additive only —
 * safe on existing installs.
 */
export class CreateQuestions1720000000030 implements MigrationInterface {
  name = 'CreateQuestions1720000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "questions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "direction" character varying NOT NULL,
        "counterpartyName" character varying NOT NULL DEFAULT '',
        "counterpartyEntityId" uuid,
        "question" text NOT NULL,
        "normalizedQuestion" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'open',
        "sourceTimestamp" double precision,
        "sourceQuote" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_questions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_questions_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_questions_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_questions_userId" ON "questions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_questions_inboxItemId" ON "questions" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_questions_user_direction_status" ON "questions" ("userId", "direction", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_questions_item_direction_question" ON "questions" ("inboxItemId", "direction", "normalizedQuestion")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "questions"`);
  }
}
