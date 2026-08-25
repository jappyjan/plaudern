#!/usr/bin/env tsx
/**
 * Migration smoke test on a REAL Postgres (JJ-74).
 *
 * The unit/e2e suites all run on better-sqlite3 with `synchronize: true`, which
 * builds the schema from the entities and IGNORES the migrations entirely. The
 * `migrations.spec.ts` guard only checks files-on-disk vs ALL_MIGRATIONS
 * registration — it never executes a line of DDL. So migration SQL correctness
 * (type mismatches, bad `down()` reversals, pgvector/GIN specifics) rested on
 * code review alone before this script.
 *
 * This runs the FULL ALL_MIGRATIONS chain against a live Postgres:
 *   1. UP  — apply every migration; assert all recorded in the migrations table.
 *   2. DOWN — revert every migration one-by-one down to the documented
 *             irreversible floor (see IRREVERSIBLE); assert each `down()` runs,
 *             exercising the reverse DDL the app's own boot path (which only
 *             ever runs `up`) can never catch. A `down()` that throws for a
 *             migration NOT on the allowlist fails the smoke — a genuinely
 *             broken reversal, not a deliberate one.
 *   3. UP again — re-apply the reverted tail, proving `down()` left the database
 *             in a clean, re-migratable state.
 *
 * It reuses ALL_ENTITIES/ALL_MIGRATIONS from the persistence lib, so it stays
 * in sync automatically as migrations are added. Point it at a database with
 * DATABASE_URL (CI provides a `pgvector/pgvector` service container — the
 * `vector` extension is required by the embedding migrations).
 *
 * Run it via the persistence nx target so its deps resolve from the lib:
 *   pnpm nx run persistence:migration-smoke        (= `pnpm migration:smoke`)
 *
 * Exit code 0 = clean; non-zero = a migration failed to apply or reverse.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
// Relative import (not `@plaudern/persistence`): this script lives INSIDE the
// persistence lib so Node resolves reflect-metadata/typeorm from the lib's own
// node_modules, which pnpm's isolated linker keeps out of the repo-root tree.
import { ALL_ENTITIES, ALL_MIGRATIONS } from '../src';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://plaudern:plaudern@localhost:5432/plaudern';

/**
 * Migrations that are DELIBERATELY irreversible — their `down()` throws by
 * design (the data they dropped cannot be recreated). The down phase stops when
 * it reaches one of these rather than treating the throw as a failure. Adding a
 * new intentionally-irreversible migration is a conscious, reviewable act: put
 * its class name here. Anything NOT listed whose `down()` throws is a bug and
 * fails the smoke.
 */
const IRREVERSIBLE = new Set<string>(['DropAuthTables1720000000001']);
const EXTRACTION_GENERATION_MIGRATION = 'AddExtractionGeneration1720000000057';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function migrationsTableCount(ds: DataSource): Promise<number> {
  const rows: Array<{ count: string }> = await ds.query('SELECT count(*)::int AS count FROM migrations');
  return Number(rows[0]?.count ?? 0);
}

async function tableExists(ds: DataSource, table: string): Promise<boolean> {
  const rows: Array<{ reg: string | null }> = await ds.query('SELECT to_regclass($1) AS reg', [
    `public.${table}`,
  ]);
  return rows[0]?.reg != null;
}

/** Name of the most recently applied migration, or null when none remain. */
async function lastAppliedName(ds: DataSource): Promise<string | null> {
  const rows: Array<{ name: string }> = await ds.query(
    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
  );
  return rows[0]?.name ?? null;
}

function createDataSource(migrations = ALL_MIGRATIONS): DataSource {
  return new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
    entities: ALL_ENTITIES,
    migrations,
    synchronize: false,
    migrationsRun: false,
  });
}

async function seedLegacyExtractions(ds: DataSource): Promise<void> {
  await ds.query(`
    INSERT INTO "inbox_items"
      ("id", "userId", "sourceType", "occurredAt", "idempotencyKey")
    VALUES
      ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'image', '2026-08-25T10:00:00Z', 'migration-item-a'),
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'audio', '2026-08-25T10:00:00Z', 'migration-item-b')
  `);
  await ds.query(`
    INSERT INTO "extracted_payloads"
      ("id", "inboxItemId", "kind", "provider", "status", "createdAt")
    VALUES
      ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'ocr', 'legacy', 'succeeded', '2026-08-25 10:00:00'),
      ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'summary', 'legacy', 'succeeded', '2026-08-25 10:00:01'),
      ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'entities', 'legacy', 'succeeded', '2026-08-25 10:00:01'),
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'transcription', 'legacy', 'succeeded', '2026-08-25 10:00:00')
  `);
}

async function assertExtractionGenerationBackfill(ds: DataSource): Promise<void> {
  const payloads: Array<{ id: string; generation: number }> = await ds.query(`
    SELECT "id", "generation"
    FROM "extracted_payloads"
    WHERE "provider" = 'legacy'
    ORDER BY "id"
  `);
  assert(
    JSON.stringify(payloads.map(({ generation }) => generation)) === JSON.stringify([1, 2, 3, 1]),
    `unexpected extraction generation backfill: ${JSON.stringify(payloads)}`,
  );
  const items: Array<{ id: string; extractionGeneration: number }> = await ds.query(`
    SELECT "id", "extractionGeneration"
    FROM "inbox_items"
    WHERE "idempotencyKey" LIKE 'migration-item-%'
    ORDER BY "id"
  `);
  assert(
    JSON.stringify(items.map(({ extractionGeneration }) => extractionGeneration)) ===
      JSON.stringify([3, 1]),
    `unexpected item generation counters: ${JSON.stringify(items)}`,
  );

  let duplicateRejected = false;
  try {
    await ds.query(`
      INSERT INTO "extracted_payloads"
        ("inboxItemId", "kind", "provider", "status", "generation")
      VALUES
        ('00000000-0000-0000-0000-0000000000a1', 'topics', 'duplicate', 'queued', 3)
    `);
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, 'duplicate positive extraction generation was accepted');
}

async function main(): Promise<void> {
  const total = ALL_MIGRATIONS.length;
  const expectedNames = ALL_MIGRATIONS.map((m) => m.name).sort();
  console.log(`[smoke] ${total} migrations to exercise against ${redact(DATABASE_URL)}`);

  const generationIndex = ALL_MIGRATIONS.findIndex(
    (migration) => migration.name === EXTRACTION_GENERATION_MIGRATION,
  );
  assert(generationIndex > 0, `${EXTRACTION_GENERATION_MIGRATION} is not registered`);

  // Exercise the new migration against a populated schema, not only an empty
  // database. This catches unsafe backfills that synchronize-based tests miss.
  const prefix = createDataSource(ALL_MIGRATIONS.slice(0, generationIndex));
  await prefix.initialize();
  try {
    const applied = await prefix.runMigrations({ transaction: 'each' });
    assert(applied.length === generationIndex, 'failed to apply the pre-generation migration chain');
    await seedLegacyExtractions(prefix);
  } finally {
    await prefix.destroy();
  }

  const ds = createDataSource();
  await ds.initialize();

  try {
    // 1. UP — apply the entire chain.
    const applied = await ds.runMigrations({ transaction: 'each' });
    assert(
      applied.length === total - generationIndex,
      `expected ${total - generationIndex} remaining migrations to apply, got ${applied.length}`,
    );
    const recorded = await migrationsTableCount(ds);
    assert(recorded === total, `expected ${total} rows in migrations table, got ${recorded}`);
    const appliedNames = ALL_MIGRATIONS.slice(0, generationIndex)
      .map((m) => m.name)
      .concat(applied.map((m) => m.name))
      .sort();
    assert(
      JSON.stringify(appliedNames) === JSON.stringify(expectedNames),
      'applied migration names do not match ALL_MIGRATIONS',
    );
    // A representative table must now exist.
    assert(await tableExists(ds, 'inbox_items'), 'inbox_items table missing after up');
    await assertExtractionGenerationBackfill(ds);
    console.log(`[smoke] up: applied all ${total} migrations ✓`);

    // 2. DOWN — reverse every migration, newest first, down to the documented
    //    irreversible floor. Each reversal executes real reverse DDL.
    let reverted = 0;
    for (;;) {
      const next = await lastAppliedName(ds);
      if (next === null) break;
      if (IRREVERSIBLE.has(next)) {
        console.log(`[smoke] down: reached documented irreversible floor at ${next}`);
        break;
      }
      try {
        await ds.undoLastMigration({ transaction: 'each' });
      } catch (err) {
        throw new Error(
          `down() failed reverting ${next} (not on the irreversible allowlist): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      reverted++;
    }
    assert(reverted > 0, 'expected at least one reversible migration to reverse');
    const floorCount = await migrationsTableCount(ds);
    assert(
      floorCount === total - reverted,
      `expected ${total - reverted} migrations left at the floor, got ${floorCount}`,
    );
    console.log(`[smoke] down: reversed ${reverted} migrations ✓`);

    // 3. UP again — the reverted tail must re-apply cleanly onto the floor.
    const reapplied = await ds.runMigrations({ transaction: 'each' });
    assert(
      reapplied.length === reverted,
      `re-apply expected ${reverted} migrations, got ${reapplied.length}`,
    );
    const afterReapply = await migrationsTableCount(ds);
    assert(afterReapply === total, `expected ${total} migrations after re-apply, got ${afterReapply}`);
    console.log(`[smoke] up (re-apply): re-applied ${reverted} migrations ✓`);

    console.log(
      `[smoke] PASS — ${total} migrations apply; ${reverted} reversible ones reverse and re-apply cleanly.`,
    );
  } finally {
    await ds.destroy();
  }
}

/** Hide credentials when echoing the connection target. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

main().catch((err) => {
  console.error('[smoke] FAIL —', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
