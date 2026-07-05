import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Account-owner identification. Adds an `isSelf` flag to voice profiles so the
 * user can mark one contact as themselves ("This is me"). Additive only — safe
 * on existing installs; existing voices default to `false` (no owner set). A
 * partial unique index guarantees at most one self profile per user.
 */
export class VoiceProfileSelf1720000000036 implements MigrationInterface {
  name = 'VoiceProfileSelf1720000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voice_profiles" ADD "isSelf" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_voice_profiles_userId_isSelf" ON "voice_profiles" ("userId") WHERE "isSelf"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_voice_profiles_userId_isSelf"`);
    await queryRunner.query(`ALTER TABLE "voice_profiles" DROP COLUMN "isSelf"`);
  }
}
