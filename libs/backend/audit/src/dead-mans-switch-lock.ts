import type { DataSource, EntityManager } from 'typeorm';
import { DeadMansSwitchEntity } from '@plaudern/persistence';

/**
 * Serialize every check-in and grant transition for one switch. Postgres can
 * lock the owner row; SQLite has no row-level lock, so its transaction begins
 * with a write statement that acquires the database writer lock.
 */
export async function withDeadMansSwitchLock<T>(
  dataSource: DataSource,
  userId: string,
  fn: (manager: EntityManager, sw: DeadMansSwitchEntity | null) => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const sqlite = runner.connection.options.type === 'better-sqlite3';

  try {
    await runner.startTransaction();
    if (sqlite) {
      // A write statement upgrades SQLite's deferred transaction before the
      // state read. Even when no row exists, SQLite acquires the writer lock.
      await runner.query(
        'UPDATE "dead_mans_switch" SET "id" = "id" WHERE "userId" = ?',
        [userId],
      );
    }

    const switches = runner.manager.getRepository(DeadMansSwitchEntity);
    const sw = await switches.findOne({
      where: { userId },
      ...(sqlite ? {} : { lock: { mode: 'pessimistic_write' as const } }),
    });
    const result = await fn(runner.manager, sw);

    await runner.commitTransaction();
    return result;
  } catch (error) {
    try {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    } catch {
      // Preserve the operation error if rollback itself fails.
    }
    throw error;
  } finally {
    await runner.release();
  }
}
