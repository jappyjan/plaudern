import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_USER_ID } from '../constants';

/**
 * Device-key auth was removed: the app is single-user and unauthenticated.
 * Re-own existing inbox rows (previously tied to a seeded random user id) to
 * the fixed DEFAULT_USER_ID, then drop the auth tables. `IF EXISTS` keeps this
 * correct on fresh databases too, where InitialSchema creates the tables and
 * this migration immediately removes them.
 */
export class DropAuthTables1720000000001 implements MigrationInterface {
  name = 'DropAuthTables1720000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "inbox_items" SET "userId" = '${DEFAULT_USER_ID}'`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }

  public async down(): Promise<void> {
    throw new Error('irreversible: auth tables were dropped');
  }
}
