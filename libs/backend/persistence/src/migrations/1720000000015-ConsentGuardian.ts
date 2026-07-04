import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Consent guardian (§ 201 StGB, ATT-663). Adds per-contact consent + redaction
 * state to voice profiles and a per-user consent-policy table. Additive only —
 * safe on existing installs; existing voices default to `unknown` consent and
 * are not redacted.
 */
export class ConsentGuardian1720000000015 implements MigrationInterface {
  name = 'ConsentGuardian1720000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voice_profiles" ADD "consentStatus" character varying NOT NULL DEFAULT 'unknown'`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_profiles" ADD "redacted" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`
      CREATE TABLE "consent_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "autoDeleteDeclined" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_consent_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_consent_settings_userId" ON "consent_settings" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "consent_settings"`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "redacted"`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "consentStatus"`);
  }
}
