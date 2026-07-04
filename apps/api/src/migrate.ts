import 'reflect-metadata';
import { AppDataSource } from '@plaudern/persistence';

/**
 * Standalone migration runner for deploys. Runs pending migrations against the
 * Postgres pointed to by DATABASE_URL, then exits: 0 on success, 1 on failure.
 *
 * Deployments run this as a one-shot gate *before* the API starts (see
 * docker-compose.coolify.yaml: the `api` service waits for `api-migrate` to
 * complete successfully). A failed or un-appliable migration therefore fails
 * the deploy loudly instead of letting the API boot and serve 500s per request
 * — which is exactly how the missing `autoLink` column slipped into production.
 */
async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const applied = await AppDataSource.runMigrations();
    if (applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[migrate] no pending migrations');
    } else {
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${applied.length}: ${applied.map((m) => m.name).join(', ')}`);
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
