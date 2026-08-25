import { MigrationInterface, QueryRunner } from 'typeorm';

/** Add durable ownership to topic-proposal jobs, writes, and completion. */
export class OwnTopicProposalRuns1720000000056 implements MigrationInterface {
  name = 'OwnTopicProposalRuns1720000000056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "topic_proposal_runs" ADD COLUMN "generationId" uuid`);
    await queryRunner.query(`UPDATE "topic_proposal_runs" SET "generationId" = "id"`);
    await queryRunner.query(
      `ALTER TABLE "topic_proposal_runs" ALTER COLUMN "generationId" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "topic_proposals" ADD COLUMN "generationId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "topic_proposals" DROP COLUMN "generationId"`);
    await queryRunner.query(`ALTER TABLE "topic_proposal_runs" DROP COLUMN "generationId"`);
  }
}
