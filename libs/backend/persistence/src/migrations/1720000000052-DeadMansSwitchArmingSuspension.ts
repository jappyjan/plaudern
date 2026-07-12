import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * JJ-80 review follow-up (F1): add `armingSuspendedForCheckInAt` to
 * `dead_mans_switch`. Today, revoking a release only closes THAT release —
 * the next sweep happily arms a brand-new pending release for the same
 * still-lapsed check-in and re-warns the owner. This column lets a revoke
 * durably disarm the switch for the CURRENT lapse: it is set to the switch's
 * `lastCheckInAt` at revoke time, and a sweep skips arming while the two
 * still match. A fresh check-in changes (and clears) `lastCheckInAt`, so the
 * marker goes stale and a later lapse arms normally again.
 *
 * Additive and nullable — safe on existing installs (existing rows read as
 * "not suppressed", the correct default).
 */
export class DeadMansSwitchArmingSuspension1720000000052 implements MigrationInterface {
  name = 'DeadMansSwitchArmingSuspension1720000000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch" ADD COLUMN "armingSuspendedForCheckInAt" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dead_mans_switch" DROP COLUMN "armingSuspendedForCheckInAt"`,
    );
  }
}
