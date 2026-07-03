import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-feed toggle for automatic recording↔event linking (see CalendarFeedEntity.autoLink). */
export class CalendarFeedAutoLink1720000000007 implements MigrationInterface {
  name = 'CalendarFeedAutoLink1720000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "calendar_feeds" ADD "autoLink" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "autoLink"`);
  }
}
