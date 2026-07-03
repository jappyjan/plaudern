import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-user passkey authentication: accounts, WebAuthn credentials and
 * cookie sessions. Additive only — existing rows keep their DEFAULT_USER_ID
 * owner, which the FIRST registered user adopts (the auth service creates
 * that user with DEFAULT_USER_ID as its id).
 */
export class CreateAuthTables1720000000008 implements MigrationInterface {
  name = 'CreateAuthTables1720000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL,
        "username" character varying NOT NULL,
        "webauthnUserId" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_users_username" ON "users" ("username")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_webauthnUserId" ON "users" ("webauthnUserId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "passkey_credentials" (
        "id" character varying NOT NULL,
        "userId" uuid NOT NULL,
        "publicKey" text NOT NULL,
        "counter" bigint NOT NULL DEFAULT 0,
        "transports" text,
        "deviceType" character varying NOT NULL,
        "backedUp" boolean NOT NULL DEFAULT false,
        "label" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "lastUsedAt" character varying,
        CONSTRAINT "PK_passkey_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "FK_passkey_credentials_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_passkey_credentials_userId" ON "passkey_credentials" ("userId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tokenHash" character varying NOT NULL,
        "userId" uuid NOT NULL,
        "expiresAt" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "lastUsedAt" character varying,
        CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_auth_sessions_tokenHash" ON "auth_sessions" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_sessions_userId" ON "auth_sessions" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
    await queryRunner.query(`DROP TABLE "passkey_credentials"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
