import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extraction-pipeline DAG (VISION §8):
 * - `extracted_payloads.version`: per-kind extractor version recorded on every
 *   appended row (existing rows backfill to 1, the version of every extractor
 *   to date). Purely additive — rows stay immutable.
 * - `extraction_runs`: bookkeeping for backfill runs ("re-run kind@version
 *   over past items"). The runs only ever append new extraction rows.
 */
export class ExtractionDag1720000000018 implements MigrationInterface {
  name = 'ExtractionDag1720000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "extracted_payloads" ADD COLUMN "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(`
      CREATE TABLE "extraction_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "targetVersion" integer NOT NULL,
        "force" boolean NOT NULL DEFAULT false,
        "occurredFrom" character varying,
        "occurredTo" character varying,
        "status" character varying NOT NULL DEFAULT 'running',
        "itemsMatched" integer NOT NULL DEFAULT 0,
        "itemsQueued" integer NOT NULL DEFAULT 0,
        "itemsSkipped" integer NOT NULL DEFAULT 0,
        "itemsFailed" integer NOT NULL DEFAULT 0,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "completedAt" character varying,
        CONSTRAINT "PK_extraction_runs" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_extraction_runs_user_createdAt" ON "extraction_runs" ("userId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "extraction_runs"`);
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN "version"`);
  }
}
