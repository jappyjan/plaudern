import { EntityManager } from 'typeorm';
import { DeadMansSwitchEntity } from '@plaudern/persistence';

/** Serialize all switch/release lifecycle transitions, even before a switch row exists. */
export async function findDeadMansSwitchForUpdate(
  em: EntityManager,
  userId: string,
  isPostgres: boolean,
): Promise<DeadMansSwitchEntity | null> {
  if (isPostgres) {
    await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `dead-mans-switch:${userId}`,
    ]);
  }
  return em.getRepository(DeadMansSwitchEntity).findOne({
    where: { userId },
    ...(isPostgres ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
}
