import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task/commitment de-duplication (task-commitment-duplicates). The `tasks` and
 * `commitments` extractors independently mine the same "I'll do X" statements,
 * so a self-directed task and an `owed_by_me` commitment for one intention
 * ("fill out the anamnesis form") surfaced twice on the item detail and in the
 * open-loops ledger. The commitments extractor now waits for `tasks` (DAG
 * `settled` edge) and, after persisting, reconciles each OPEN `owed_by_me`
 * commitment against the item's tasks — semantically via the shared embeddings,
 * with a normalized-text fallback. A match stamps the winning `tasks.id` here;
 * the commitment read models then hide stamped rows, keeping the richer task.
 *
 * Additive and nullable: safe on existing installs. The startup backfill
 * re-runs `commitments` (its extractor version was bumped) so already-ingested
 * items get reconciled on the next deploy.
 */
export class AddCommitmentDuplicatesTask1720000000034 implements MigrationInterface {
  name = 'AddCommitmentDuplicatesTask1720000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commitments" ADD "duplicatesTaskId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commitments" DROP COLUMN "duplicatesTaskId"`);
  }
}
