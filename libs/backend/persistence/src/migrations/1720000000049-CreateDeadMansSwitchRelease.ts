import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dead-man's-switch RELEASE state (JJ-80) — the follow-up that makes the JJ-42
 * scaffold actually fire. `dead_mans_switch` holds the owner's intent (trusted
 * contact + check-in interval); this `dead_mans_switch_release` table holds each
 * ACTUAL firing: when a check-in lapses the scheduler writes a `pending` row
 * (grace/confirmation window), then — if no re-check-in intervenes — flips it to
 * `active` and emails the contact a scoped, read-only, owner-revocable grant to
 * the archive export. Only the SHA-256 of the grant token is stored.
 *
 * Additive only (safe on existing installs). Uses `gen_random_uuid()` /
 * `TIMESTAMP` / plain `character varying`, the same cross-driver-safe subset the
 * sibling migrations use, so it applies cleanly under the Postgres smoke CI
 * (JJ-74) and is a no-op under the sqlite `synchronize` test path.
 */
export class CreateDeadMansSwitchRelease1720000000049 implements MigrationInterface {
  name = 'CreateDeadMansSwitchRelease1720000000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "dead_mans_switch_release" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "contactEmail" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "tokenHash" character varying,
        "firedAt" character varying NOT NULL,
        "graceUntil" character varying NOT NULL,
        "grantedAt" character varying,
        "closedAt" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dead_mans_switch_release" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_dead_mans_switch_release_userId" ON "dead_mans_switch_release" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dead_mans_switch_release_status" ON "dead_mans_switch_release" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "dead_mans_switch_release"`);
  }
}
