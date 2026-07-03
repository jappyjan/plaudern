import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the pyannoteAI (hosted API) voice-identity path alongside the existing
 * embedding path. A voice profile now carries EITHER a `centroid` embedding
 * (local sidecar) OR an opaque `voiceprint` (pyannoteAI); the previously
 * mandatory embedding columns become nullable so a profile/occurrence created
 * by one path is not forced to synthesise a value for the other. Additive and
 * safe on existing installs — existing rows keep their centroids/embeddings.
 */
export class PyannoteAiVoiceprints1720000000009 implements MigrationInterface {
  name = 'PyannoteAiVoiceprints1720000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "voice_profiles" ADD "voiceprint" text`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" ALTER COLUMN "centroid" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "speaker_occurrences" ALTER COLUMN "embedding" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting requires a value for the now-mandatory columns; drop rows that
    // relied on the nullable state (voiceprint-only profiles) so the NOT NULL
    // constraints can be restored.
    await queryRunner.query(`DELETE FROM "speaker_occurrences" WHERE "embedding" IS NULL`);
    await queryRunner.query(`DELETE FROM "voice_profiles" WHERE "centroid" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "speaker_occurrences" ALTER COLUMN "embedding" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "voice_profiles" ALTER COLUMN "centroid" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "voiceprint"`);
  }
}
