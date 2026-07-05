import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Topic taxonomy proposals from embedding clusters (JJ-64): a per-user table of
 * suggested taxonomy extensions derived by clustering recent items' embeddings
 * and labeling each cluster with the LLM. Accepting a proposal creates a topic
 * and reclassifies the cluster's items; dismissing it retains the row so its
 * fingerprint suppresses that cluster from being re-proposed. Additive only —
 * safe on existing installs.
 */
export class CreateTopicProposals1720000000032 implements MigrationInterface {
  name = 'CreateTopicProposals1720000000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "topic_proposals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "fingerprint" character varying NOT NULL,
        "label" character varying NOT NULL,
        "description" text,
        "itemCount" integer NOT NULL,
        "memberItemIds" text NOT NULL,
        "sampleItemIds" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "acceptedTopicId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_proposals" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_proposals_userId" ON "topic_proposals" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_proposals_userId_status" ON "topic_proposals" ("userId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_proposals_userId_fingerprint" ON "topic_proposals" ("userId", "fingerprint")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "topic_proposals"`);
  }
}
