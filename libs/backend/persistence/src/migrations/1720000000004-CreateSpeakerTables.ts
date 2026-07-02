import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Speaker identification: timed segments on extractions, voice profiles
 * (persistent people) and per-recording speaker occurrences. Additive only —
 * safe on existing installs.
 */
export class CreateSpeakerTables1720000000004 implements MigrationInterface {
  name = 'CreateSpeakerTables1720000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "extracted_payloads" ADD "segments" text`);

    await queryRunner.query(`
      CREATE TABLE "voice_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "name" character varying,
        "status" character varying NOT NULL DEFAULT 'unconfirmed',
        "centroid" text NOT NULL,
        "embeddingCount" integer NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_voice_profiles" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_voice_profiles_userId" ON "voice_profiles" ("userId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "speaker_occurrences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "voiceProfileId" uuid NOT NULL,
        "label" character varying NOT NULL,
        "embedding" text NOT NULL,
        "speakingSeconds" double precision NOT NULL DEFAULT 0,
        "similarity" double precision,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_speaker_occurrences" PRIMARY KEY ("id"),
        CONSTRAINT "FK_speaker_occurrences_item" FOREIGN KEY ("inboxItemId") REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_speaker_occurrences_extraction" FOREIGN KEY ("extractionId") REFERENCES "extracted_payloads"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_speaker_occurrences_profile" FOREIGN KEY ("voiceProfileId") REFERENCES "voice_profiles"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_speaker_occurrences_item" ON "speaker_occurrences" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_speaker_occurrences_profile" ON "speaker_occurrences" ("voiceProfileId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_speaker_occurrences_extraction_label" ON "speaker_occurrences" ("extractionId", "label")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "speaker_occurrences"`);
    await queryRunner.query(`DROP TABLE "voice_profiles"`);
    await queryRunner.query(`ALTER TABLE "extracted_payloads" DROP COLUMN "segments"`);
  }
}
