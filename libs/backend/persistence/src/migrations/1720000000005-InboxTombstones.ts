import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tombstones for deleted inbox items (see InboxTombstoneEntity). */
export class InboxTombstones1720000000005 implements MigrationInterface {
  name = 'InboxTombstones1720000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inbox_tombstones" (
        "userId" uuid NOT NULL,
        "idempotencyKey" character varying NOT NULL,
        "deletedItemId" uuid NOT NULL,
        "sourceType" character varying NOT NULL,
        "deletedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inbox_tombstones" PRIMARY KEY ("userId", "idempotencyKey")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "inbox_tombstones"`);
  }
}
