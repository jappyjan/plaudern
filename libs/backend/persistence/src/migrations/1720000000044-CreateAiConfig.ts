import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user AI configuration (replaces the per-capability `<PREFIX>_*` env vars):
 * - `ai_providers`: reusable provider *connections* (credentials). The API key
 *   is encrypted at rest (APP_ENCRYPTION_SECRET) and nullable for keyless local
 *   endpoints.
 * - `ai_capability_settings`: which provider connection + model powers each
 *   capability, one row per (user, capability).
 *
 * Additive only — safe on existing installs. The one-time env→DB import that
 * seeds these for the pre-auth owner runs at boot (AiConfigImportService), not
 * here, so it can read the running API process's env and encrypt keys.
 */
export class CreateAiConfig1720000000044 implements MigrationInterface {
  name = 'CreateAiConfig1720000000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_providers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "protocol" character varying NOT NULL,
        "baseUrl" character varying NOT NULL,
        "apiKeyEncrypted" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_providers" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_providers_userId" ON "ai_providers" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ai_providers_userId_name" ON "ai_providers" ("userId", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ai_capability_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "capability" character varying NOT NULL,
        "providerId" uuid,
        "model" character varying,
        "timeoutMs" integer,
        "enabled" boolean NOT NULL DEFAULT true,
        "params" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_capability_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_capability_settings_userId" ON "ai_capability_settings" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ai_capability_settings_userId_capability" ON "ai_capability_settings" ("userId", "capability")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_capability_settings"`);
    await queryRunner.query(`DROP TABLE "ai_providers"`);
  }
}
