import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds collision-free per-item ordering for extraction DAG generations. */
export class AddExtractionGeneration1720000000057 implements MigrationInterface {
  name = 'AddExtractionGeneration1720000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inbox_items" ADD COLUMN "extractionGeneration" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "extracted_payloads" ADD COLUMN "generation" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      WITH "ranked" AS (
        SELECT
          "id",
          row_number() OVER (
            PARTITION BY "inboxItemId"
            ORDER BY "createdAt", "id"
          ) AS "generation"
        FROM "extracted_payloads"
      )
      UPDATE "extracted_payloads" AS "payload"
      SET "generation" = "ranked"."generation"
      FROM "ranked"
      WHERE "payload"."id" = "ranked"."id"
    `);
    await queryRunner.query(`
      UPDATE "inbox_items" AS "item"
      SET "extractionGeneration" = COALESCE((
        SELECT max("payload"."generation")
        FROM "extracted_payloads" AS "payload"
        WHERE "payload"."inboxItemId" = "item"."id"
      ), 0)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_extracted_payloads_item_generation"
      ON "extracted_payloads" ("inboxItemId", "generation")
      WHERE "generation" > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_extracted_payloads_item_generation"`);
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN "generation"`);
    await queryRunner.query(`ALTER TABLE "inbox_items" DROP COLUMN "extractionGeneration"`);
  }
}
