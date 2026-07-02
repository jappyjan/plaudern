import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plaud cloud sync configuration (one row per user). Additive only — safe on
 * existing installs.
 */
export class CreatePlaudSettings1720000000002 implements MigrationInterface {
  name = 'CreatePlaudSettings1720000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "plaud_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "email" character varying NOT NULL,
        "passwordEncrypted" text NOT NULL,
        "region" character varying NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "accessToken" text,
        "accessTokenExpiresAt" character varying,
        "lastSyncAt" character varying,
        "lastSyncStatus" character varying,
        "lastSyncError" text,
        "lastSyncImportedCount" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plaud_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_plaud_settings_userId" ON "plaud_settings" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "plaud_settings"`);
  }
}
