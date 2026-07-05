import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Memory chat (JJ-37): persisted conversations and messages. Assistant
 * messages store their enforced citations as a JSON `text` column — each
 * citation snapshots (inboxItemId, optional transcript timestamp, snippet) at
 * answer time, so an old conversation replays with the evidence its answer was
 * actually based on. Deliberately no FK from citations to inbox items: a later
 * item deletion must not rewrite chat history (the UI handles a dead link).
 * Additive only: safe on existing installs.
 */
export class CreateChatTables1720000000033 implements MigrationInterface {
  name = 'CreateChatTables1720000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_conversations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "title" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chat_conversations" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_conversations_userId" ON "chat_conversations" ("userId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conversationId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "role" character varying NOT NULL,
        "content" text NOT NULL,
        "citations" text NOT NULL,
        "confidence" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chat_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chat_messages_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "chat_conversations"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_userId" ON "chat_messages" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_conversation_createdAt" ON "chat_messages" ("conversationId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "chat_messages"`);
    await queryRunner.query(`DROP TABLE "chat_conversations"`);
  }
}
