import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AddExtractionGeneration1720000000057 } from './migrations/1720000000057-AddExtractionGeneration';

describe('AddExtractionGeneration1720000000057', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    await dataSource.query(`
      CREATE TABLE "inbox_items" (
        "id" varchar PRIMARY KEY,
        "userId" varchar NOT NULL
      )
    `);
    await dataSource.query(`
      CREATE TABLE "extracted_payloads" (
        "id" varchar PRIMARY KEY,
        "inboxItemId" varchar NOT NULL,
        "createdAt" datetime NOT NULL
      )
    `);
    await dataSource.query(
      `INSERT INTO "inbox_items" ("id", "userId") VALUES ('item-a', 'user'), ('item-b', 'user')`,
    );
    await dataSource.query(`
      INSERT INTO "extracted_payloads" ("id", "inboxItemId", "createdAt") VALUES
        ('a-older', 'item-a', '2026-08-25 10:00:00'),
        ('a-tie-1', 'item-a', '2026-08-25 10:00:01'),
        ('a-tie-2', 'item-a', '2026-08-25 10:00:01'),
        ('b-only', 'item-b', '2026-08-25 10:00:00')
    `);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('backfills deterministic per-item order and remains reversible', async () => {
    const migration = new AddExtractionGeneration1720000000057();
    const runner = dataSource.createQueryRunner();

    await migration.up(runner);

    const payloads = (await dataSource.query(
      `SELECT "id", "generation" FROM "extracted_payloads" ORDER BY "id"`,
    )) as Array<{ id: string; generation: number }>;
    expect(payloads).toEqual([
      { id: 'a-older', generation: 1 },
      { id: 'a-tie-1', generation: 2 },
      { id: 'a-tie-2', generation: 3 },
      { id: 'b-only', generation: 1 },
    ]);
    const items = (await dataSource.query(
      `SELECT "id", "extractionGeneration" FROM "inbox_items" ORDER BY "id"`,
    )) as Array<{ id: string; extractionGeneration: number }>;
    expect(items).toEqual([
      { id: 'item-a', extractionGeneration: 3 },
      { id: 'item-b', extractionGeneration: 1 },
    ]);
    await expect(
      dataSource.query(`
        INSERT INTO "extracted_payloads" ("id", "inboxItemId", "createdAt", "generation")
        VALUES ('a-duplicate', 'item-a', '2026-08-25 10:00:02', 3)
      `),
    ).rejects.toThrow();

    await migration.down(runner);
    const payloadColumns = (await dataSource.query(
      `SELECT "name" FROM pragma_table_info('extracted_payloads')`,
    )) as Array<{ name: string }>;
    const itemColumns = (await dataSource.query(
      `SELECT "name" FROM pragma_table_info('inbox_items')`,
    )) as Array<{ name: string }>;
    expect(payloadColumns.map(({ name }) => name)).not.toContain('generation');
    expect(itemColumns.map(({ name }) => name)).not.toContain('extractionGeneration');

    await migration.up(runner);
    await runner.release();
  });
});
