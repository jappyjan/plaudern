import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI-provider audit log & data-sovereignty controls (JJ-42).
 *
 * `ai_provider_calls`: an append-only, user-scoped audit trail of every request
 * sent to an external AI provider (transcription, diarization, LLM, embeddings).
 * Stores metadata + size + a SHA-256 content hash — NOT the payload — plus an
 * opt-in redacted payload column that stays null unless the operator enables it.
 *
 * `dead_mans_switch`: a minimal per-user scaffold for legacy/emergency access
 * (a trusted contact + check-in interval). Additive only — safe on existing
 * installs.
 */
export class DataSovereignty1720000000041 implements MigrationInterface {
  name = 'DataSovereignty1720000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_provider_calls" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid,
        "kind" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "endpoint" character varying NOT NULL,
        "direction" character varying NOT NULL DEFAULT 'outbound',
        "bytesSent" bigint NOT NULL,
        "contentHash" character varying NOT NULL,
        "payloadRedacted" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_provider_calls" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_provider_calls_user_createdAt" ON "ai_provider_calls" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_provider_calls_user_kind" ON "ai_provider_calls" ("userId", "kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_provider_calls_inboxItemId" ON "ai_provider_calls" ("inboxItemId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "dead_mans_switch" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "contactEmail" character varying,
        "checkInIntervalDays" integer NOT NULL DEFAULT 90,
        "lastCheckInAt" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dead_mans_switch" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_dead_mans_switch_userId" ON "dead_mans_switch" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "dead_mans_switch"`);
    await queryRunner.query(`DROP TABLE "ai_provider_calls"`);
  }
}
