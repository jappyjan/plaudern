import { MigrationInterface, QueryRunner } from 'typeorm';

/** Removes the retired auto-journal feature and all generated journal data. */
export class DropJournalDocuments1720000000055 implements MigrationInterface {
  name = 'DropJournalDocuments1720000000055';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "ai_provider_calls" WHERE "kind" = 'journal'`);
    await queryRunner.query(`DELETE FROM "ai_capability_settings" WHERE "capability" = 'journal'`);
    await queryRunner.query(`DROP TABLE "journal_documents"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_journal_documents_period_version" ON "journal_documents" ("userId", "periodType", "periodKey", "version")`,
    );
  }
}
