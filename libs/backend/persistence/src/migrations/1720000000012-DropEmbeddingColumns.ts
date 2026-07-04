import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The local (sidecar) embedding path was removed — speaker identity is carried
 * exclusively by pyannoteAI voiceprints now. Drop the embedding columns nothing
 * reads or writes anymore: profile centroids and per-occurrence embeddings.
 * Profiles created by the old path keep working for manual review/merge; they
 * just are not auto-matchable (no voiceprint).
 */
export class DropEmbeddingColumns1720000000012 implements MigrationInterface {
  name = 'DropEmbeddingColumns1720000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "centroid"`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "embeddingCount"`);
    await queryRunner.query(`ALTER TABLE "speaker_occurrences" DROP COLUMN "embedding"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The dropped data is not recoverable; restore the columns empty.
    await queryRunner.query(`ALTER TABLE "voice_profiles" ADD "centroid" text`);
    await queryRunner.query(
      `ALTER TABLE "voice_profiles" ADD "embeddingCount" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(`ALTER TABLE "speaker_occurrences" ADD "embedding" text`);
  }
}
