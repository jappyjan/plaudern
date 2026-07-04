import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email-in configuration (one row per user): the encrypted+redisplayable token
 * plus its sha256 lookup hash for the inbound webhook. Additive only — safe on
 * existing installs.
 */
export class CreateEmailSettings1720000000016 implements MigrationInterface {
  name = 'CreateEmailSettings1720000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "tokenEncrypted" text NOT NULL,
        "tokenHash" character varying NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_email_settings_userId" ON "email_settings" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_email_settings_tokenHash" ON "email_settings" ("tokenHash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_settings"`);
  }
}
