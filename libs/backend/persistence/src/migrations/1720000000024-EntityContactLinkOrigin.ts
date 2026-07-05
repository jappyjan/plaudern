import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contact-link provenance for the entity registry: `voiceProfileLinkOrigin`
 * records whether a person entity's contact link was made automatically
 * (`auto`), by the user (`manual`), or explicitly removed (`suppressed`, which
 * stops auto-linking from re-linking it). Existing links predate the column
 * and were all name matches, so they backfill as `auto`. Additive only: safe
 * on existing installs.
 */
export class EntityContactLinkOrigin1720000000024 implements MigrationInterface {
  name = 'EntityContactLinkOrigin1720000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "entities" ADD COLUMN "voiceProfileLinkOrigin" character varying`,
    );
    await queryRunner.query(
      `UPDATE "entities" SET "voiceProfileLinkOrigin" = 'auto' WHERE "voiceProfileId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "entities" DROP COLUMN "voiceProfileLinkOrigin"`);
  }
}
