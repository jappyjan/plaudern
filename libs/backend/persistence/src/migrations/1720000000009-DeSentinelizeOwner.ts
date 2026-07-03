import { randomUUID } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_USER_ID, USER_OWNED_DATA_TABLES } from '../constants';

/**
 * Repairs deployments created by the first passkey build, which mistakenly
 * gave the very first (owner) account the fixed sentinel id
 * 00000000-0000-0000-0000-000000000001. A static, guessable id on the most
 * privileged account is a security problem, and it isn't a valid RFC-9562
 * UUID either — so the web client's `authUserSchema` fail-parsed every
 * /auth/me and register/login response for that account, blocking sign-in.
 *
 * Re-key that account to a fresh random UUID, carrying every owned row with
 * it: the FK children (passkey_credentials, auth_sessions) and all the
 * plain-`userId` tables. The two owner FKs are dropped and restored around
 * the re-key because they have no ON UPDATE CASCADE.
 *
 * A no-op when no such account exists — i.e. a healthy install, or one whose
 * DEFAULT_USER_ID rows are still genuine pre-auth data waiting to be adopted
 * by the first real registration (leaving those untouched is deliberate).
 */
export class DeSentinelizeOwner1720000000009 implements MigrationInterface {
  name = 'DeSentinelizeOwner1720000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const owner = await queryRunner.query(`SELECT "id" FROM "users" WHERE "id" = $1`, [
      DEFAULT_USER_ID,
    ]);
    if (!owner || owner.length === 0) return;

    const newOwnerId = randomUUID();

    await queryRunner.query(
      `ALTER TABLE "passkey_credentials" DROP CONSTRAINT "FK_passkey_credentials_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_auth_sessions_user"`,
    );

    await queryRunner.query(`UPDATE "users" SET "id" = $1 WHERE "id" = $2`, [
      newOwnerId,
      DEFAULT_USER_ID,
    ]);
    for (const table of [...USER_OWNED_DATA_TABLES, 'passkey_credentials', 'auth_sessions']) {
      await queryRunner.query(`UPDATE "${table}" SET "userId" = $1 WHERE "userId" = $2`, [
        newOwnerId,
        DEFAULT_USER_ID,
      ]);
    }

    await queryRunner.query(
      `ALTER TABLE "passkey_credentials" ADD CONSTRAINT "FK_passkey_credentials_user" ` +
        `FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_auth_sessions_user" ` +
        `FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible: the fresh owner id is random and the old static sentinel is
    // exactly the state we are removing — there is nothing safe to restore to.
  }
}
