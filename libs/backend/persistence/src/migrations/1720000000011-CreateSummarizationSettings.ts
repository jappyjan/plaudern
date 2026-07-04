import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user AI summarization preferences (one row per user). Additive only —
 * safe on existing installs; users without a row fall back to `auto`.
 */
export class CreateSummarizationSettings1720000000011 implements MigrationInterface {
  name = 'CreateSummarizationSettings1720000000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "summarization_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "language" character varying NOT NULL DEFAULT 'auto',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_summarization_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_summarization_settings_userId" ON "summarization_settings" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "summarization_settings"`);
  }
}
