import { MigrationInterface, QueryRunner } from 'typeorm';

/** Enforces per-item generation uniqueness without blocking Postgres writers. */
export class IndexExtractionGeneration1720000000058 implements MigrationInterface {
  name = 'IndexExtractionGeneration1720000000058';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const concurrently = queryRunner.connection.options.type === 'postgres' ? ' CONCURRENTLY' : '';
    await queryRunner.query(`
      CREATE UNIQUE INDEX${concurrently} "UQ_extracted_payloads_item_generation"
      ON "extracted_payloads" ("inboxItemId", "generation")
      WHERE "generation" > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const concurrently = queryRunner.connection.options.type === 'postgres' ? ' CONCURRENTLY' : '';
    await queryRunner.query(
      `DROP INDEX${concurrently} "UQ_extracted_payloads_item_generation"`,
    );
  }
}
