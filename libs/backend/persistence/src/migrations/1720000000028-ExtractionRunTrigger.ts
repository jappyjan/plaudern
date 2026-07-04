import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Automatic startup backfill (catch missing/failed steps up on every boot):
 * - `extraction_runs.trigger`: labels how a run was started — `manual` (an
 *   explicit POST /v1/extractions/backfills) or `startup` (the automatic
 *   boot sweep). Existing rows backfill to `manual`.
 * - `extraction_runs.userId` becomes nullable: startup sweeps are system-wide
 *   (they scan every user's items), so their run row is not scoped to a user.
 *
 * Purely additive — existing runs and their counters are untouched.
 */
export class ExtractionRunTrigger1720000000028 implements MigrationInterface {
  name = 'ExtractionRunTrigger1720000000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "extraction_runs" ADD COLUMN "trigger" character varying NOT NULL DEFAULT 'manual'`,
    );
    await queryRunner.query(`ALTER TABLE "extraction_runs" ALTER COLUMN "userId" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "extraction_runs" ALTER COLUMN "userId" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "extraction_runs" DROP COLUMN "trigger"`);
  }
}
