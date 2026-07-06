import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Commitment-nudge state (JJ-26): a user-scoped `nudge_state` table holding the
 * per-commitment state the DERIVED nudge view can't recompute — whether a
 * proactive notification already fired (`nudgedAt`, system-owned) and the user's
 * dismiss / snooze decisions (`dismissed` / `snoozedUntil`, user-owned).
 *
 * Keyed uniquely by (userId, commitmentId) and FK-cascaded with the commitment,
 * so the state rides along when a commitment is upserted on re-extraction and is
 * dropped only if the commitment itself is reaped. Additive only — safe on
 * existing installs.
 */
export class CreateNudgeState1720000000047 implements MigrationInterface {
  name = 'CreateNudgeState1720000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "nudge_state" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "commitmentId" uuid NOT NULL,
        "nudgedAt" character varying,
        "dismissed" boolean NOT NULL DEFAULT false,
        "snoozedUntil" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_nudge_state" PRIMARY KEY ("id"),
        CONSTRAINT "FK_nudge_state_commitment" FOREIGN KEY ("commitmentId")
          REFERENCES "commitments"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_nudge_state_userId" ON "nudge_state" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_nudge_state_user_commitment" ON "nudge_state" ("userId", "commitmentId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "nudge_state"`);
  }
}
