import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep an encrypted emergency credential only while contact delivery is pending.
 * Existing pending rows have no reserved token and mint one on their next sweep;
 * existing active/terminal rows need no backfill.
 */
export class RetryDeadMansSwitchDelivery1720000000057 implements MigrationInterface {
  name = 'RetryDeadMansSwitchDelivery1720000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch_release" ADD "tokenEncrypted" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch_release" DROP COLUMN "tokenEncrypted"`,
    );
  }
}
