import { MigrationInterface, QueryRunner } from 'typeorm';

/** Retryable emergency-access delivery without retaining a plaintext token. */
export class AddDeadMansSwitchDeliveryToken1720000000057 implements MigrationInterface {
  name = 'AddDeadMansSwitchDeliveryToken1720000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch_release" ADD "tokenEncrypted" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch_release" DROP COLUMN "tokenEncrypted"`,
    );
  }
}
