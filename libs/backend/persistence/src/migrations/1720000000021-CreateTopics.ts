import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Topic/project classification (JJ-18): a per-user, editable taxonomy
 * (`topics`) plus a latest-only projection (`item_topics`) of the assignments
 * produced by the zero-shot `topics` extraction. The immutable record of each
 * classification lives in `extracted_payloads.content`; `item_topics` exists so
 * "list items by topic" is a cheap indexed query. Additive only — safe on
 * existing installs.
 */
export class CreateTopics1720000000021 implements MigrationInterface {
  name = 'CreateTopics1720000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "topics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "description" text,
        "archived" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topics" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_topics_userId" ON "topics" ("userId")`);

    await queryRunner.query(`
      CREATE TABLE "item_topics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "extractionId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "topicId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "confidence" double precision NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_item_topics" PRIMARY KEY ("id"),
        CONSTRAINT "FK_item_topics_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_item_topics_userId" ON "item_topics" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_item_topics_topicId" ON "item_topics" ("topicId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_item_topics_inboxItemId" ON "item_topics" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_item_topics_extractionId" ON "item_topics" ("extractionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "item_topics"`);
    await queryRunner.query(`DROP TABLE "topics"`);
  }
}
