import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds collision-free per-item ordering for extraction DAG generations. */
export class AddExtractionGeneration1720000000057 implements MigrationInterface {
  name = 'AddExtractionGeneration1720000000057';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query(
        `ALTER TABLE "inbox_items" ADD COLUMN IF NOT EXISTS "extractionGeneration" integer NOT NULL DEFAULT 0`,
      );
      await queryRunner.query(
        `ALTER TABLE "extracted_payloads" ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 0`,
      );
      await this.backfillPostgres(queryRunner);
      return;
    }

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
  }

  private async backfillPostgres(queryRunner: QueryRunner): Promise<void> {
    for (;;) {
      const items = (await queryRunner.query(`
        SELECT DISTINCT "inboxItemId"
        FROM "extracted_payloads"
        WHERE "generation" = 0
        ORDER BY "inboxItemId"
        LIMIT 1000
      `)) as Array<{ inboxItemId: string }>;
      if (items.length === 0) return;

      const itemIds = items.map(({ inboxItemId }) => inboxItemId);
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(
          `
            WITH "ranked" AS (
              SELECT
                "id",
                row_number() OVER (
                  PARTITION BY "inboxItemId"
                  ORDER BY "createdAt", "id"
                ) AS "generation"
              FROM "extracted_payloads"
              WHERE "inboxItemId" = ANY($1::uuid[])
            )
            UPDATE "extracted_payloads" AS "payload"
            SET "generation" = "ranked"."generation"
            FROM "ranked"
            WHERE "payload"."id" = "ranked"."id"
          `,
          [itemIds],
        );
        await queryRunner.query(
          `
            UPDATE "inbox_items" AS "item"
            SET "extractionGeneration" = COALESCE((
              SELECT max("payload"."generation")
              FROM "extracted_payloads" AS "payload"
              WHERE "payload"."inboxItemId" = "item"."id"
            ), 0)
            WHERE "item"."id" = ANY($1::uuid[])
          `,
          [itemIds],
        );
        await queryRunner.commitTransaction();
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const ifExists = queryRunner.connection.options.type === 'postgres' ? ' IF EXISTS' : '';
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN${ifExists} "generation"`);
    await queryRunner.query(
      `ALTER TABLE "inbox_items" DROP COLUMN${ifExists} "extractionGeneration"`,
    );
  }
}
