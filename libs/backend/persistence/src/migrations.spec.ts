import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MIGRATIONS } from './persistence.module';

/**
 * Guards the exact failure that broke every calendar endpoint in production:
 * a migration file (`1720000000007-CalendarFeedAutoLink`) existed and the
 * entity declared the column, but the migration was never added to
 * ALL_MIGRATIONS — so on Postgres (migrationsRun) the column was never
 * created and every `SELECT ... FROM calendar_feeds` failed with
 * `column "autoLink" does not exist`.
 *
 * The unit/e2e suites can't catch this: they run on sqlite with
 * `synchronize: true`, which builds the schema from the entities and ignores
 * migrations entirely. This test compares the migration *files* on disk
 * against what's registered, so a forgotten registration fails CI instead of
 * production.
 *
 * File convention: `<timestamp>-<Name>.ts` exporting class `<Name><timestamp>`.
 */
describe('ALL_MIGRATIONS registration', () => {
  const migrationsDir = join(__dirname, 'migrations');

  const fileClassNames = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => {
      const base = f.replace(/\.ts$/, '');
      const dash = base.indexOf('-');
      const timestamp = base.slice(0, dash);
      const name = base.slice(dash + 1);
      return `${name}${timestamp}`;
    })
    .sort();

  const registeredClassNames = ALL_MIGRATIONS.map((m) => m.name).sort();

  it('registers every migration file (none forgotten, none stale)', () => {
    expect(registeredClassNames).toEqual(fileClassNames);
  });

  it('finds at least one migration file', () => {
    // Sanity check so a bad path can't make the comparison pass vacuously.
    expect(fileClassNames.length).toBeGreaterThan(0);
  });
});
