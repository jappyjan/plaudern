import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auto-journal entries (JJ-17): an append-only per-period table holding each
 * generated version of a journal entry — a daily narrative diary, or a
 * weekly/monthly/yearly review composed from the dailies. The current entry for
 * a period is the highest-version succeeded row; older rows are the visible
 * version history. `citations` stores the structural source list the body's
 * inline `[n]` markers resolve against. Additive only — safe on existing
 * installs (the feature ships disabled until JOURNAL_API_KEY / the summarization
 * key is set).
 *
 * Migration slot 1720000000039: 037 (VoiceProfileSelf) and 038 (sibling wave)
 * were taken, so this uses the next free timestamp to keep one row per
 * migration with no collisions.
 */
export class CreateJournalDocuments1720000000039 implements MigrationInterface {
  name = 'CreateJournalDocuments1720000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "journal_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "periodType" character varying NOT NULL,
        "periodKey" character varying NOT NULL,
        "version" integer NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "markdown" text,
        "citations" text,
        "sourceItemCount" integer NOT NULL DEFAULT 0,
        "model" character varying,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_journal_documents" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_journal_documents_userId" ON "journal_documents" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_journal_documents_userId_periodType" ON "journal_documents" ("userId", "periodType")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_journal_documents_period_status" ON "journal_documents" ("userId", "periodType", "periodKey", "status")`,
    );
    // One row per (user, periodType, periodKey, version): keeps version
    // numbering consistent and lets a racing concurrent generation recover from
    // the unique violation.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_journal_documents_period_version" ON "journal_documents" ("userId", "periodType", "periodKey", "version")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "journal_documents"`);
  }
}
