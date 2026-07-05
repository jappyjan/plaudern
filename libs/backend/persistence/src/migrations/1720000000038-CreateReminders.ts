import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prospective-memory reminders (JJ-25): a user-scoped `reminders` table holding
 * future-dated events pulled from recordings — "the results should be in by the
 * 14th", contract expiries, "let's talk again next month". Each row carries the
 * reminder title, the resolved absolute `dueAt` instant (relative phrases are
 * resolved server-side against the recording's occurredAt), the model's
 * confidence, a user-advanced `status` (active / done / dismissed), and the
 * source segment for citation.
 *
 * Deduped on (inboxItemId, dedupeKey = normalizedTitle|dueDay) so re-runs and
 * backfills upsert onto the same row instead of duplicating (only still-active
 * rows are reaped on re-runs; done/dismissed rows are user-owned and durable).
 * Additive only — safe on existing installs.
 */
export class CreateReminders1720000000038 implements MigrationInterface {
  name = 'CreateReminders1720000000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "reminders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "title" text NOT NULL,
        "dedupeKey" character varying NOT NULL,
        "dueAt" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'active',
        "confidence" double precision,
        "sourceTimestamp" double precision,
        "sourceQuote" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reminders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_reminders_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_reminders_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_reminders_userId" ON "reminders" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reminders_inboxItemId" ON "reminders" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reminders_user_status" ON "reminders" ("userId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reminders_user_dueAt" ON "reminders" ("userId", "dueAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_reminders_item_dedupe" ON "reminders" ("inboxItemId", "dedupeKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reminders"`);
  }
}
