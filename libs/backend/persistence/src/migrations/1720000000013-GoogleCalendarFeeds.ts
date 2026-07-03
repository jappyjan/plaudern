import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Native Google Calendar feeds: relax the ICS-only url* columns to nullable and
 * add google-specific columns. Additive; safe on existing installs (existing
 * rows are all ICS with url* populated). The (userId, urlHash) unique index is
 * unchanged — Postgres allows multiple NULLs, so google rows (urlHash NULL) do
 * not collide.
 */
export class GoogleCalendarFeeds1720000000013 implements MigrationInterface {
  name = 'GoogleCalendarFeeds1720000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlEncrypted" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlHash" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlMasked" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleCalendarId" character varying`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleAccountEmail" character varying`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleRefreshTokenEncrypted" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleRefreshTokenEncrypted"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleAccountEmail"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleCalendarId"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlMasked" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlHash" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlEncrypted" SET NOT NULL`);
  }
}
