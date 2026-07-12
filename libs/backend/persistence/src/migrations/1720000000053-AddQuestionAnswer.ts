import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `answer` to `questions`: the answer text the user (or their agent, via
 * the MCP `answer_question` tool) recorded when resolving an open question.
 * USER-owned like a settled status — the extraction upsert never writes it, so
 * re-extraction can never clobber it. Additive and nullable — safe on existing
 * installs (older answered questions simply carry no recorded text).
 *
 * NB: migration numbers 051/052 are reserved by parallel lanes (JJ-69 / #121);
 * this lane owns 053.
 */
export class AddQuestionAnswer1720000000053 implements MigrationInterface {
  name = 'AddQuestionAnswer1720000000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "questions" ADD COLUMN "answer" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "questions" DROP COLUMN "answer"`);
  }
}
