import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user MCP access tokens (JJ-14): the Bearer credential an MCP client
 * presents to reach the user's memory over `/api/mcp`. Only the sha256 hash is
 * stored (the token is never redisplayable), plus a short non-sensitive prefix
 * for the settings UI. One row per user. Additive only — safe on existing
 * installs.
 */
export class CreateMcpTokens1720000000022 implements MigrationInterface {
  name = 'CreateMcpTokens1720000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mcp_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "tokenHash" character varying NOT NULL,
        "tokenPrefix" character varying NOT NULL,
        "lastUsedAt" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mcp_tokens" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mcp_tokens_userId" ON "mcp_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mcp_tokens_tokenHash" ON "mcp_tokens" ("tokenHash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mcp_tokens"`);
  }
}
