import type { EntityManager } from 'typeorm';
import { findDeadMansSwitchForUpdate } from './dead-mans-switch-lifecycle';

describe('findDeadMansSwitchForUpdate', () => {
  it('takes a per-user PostgreSQL lock before looking up a possibly absent row', async () => {
    const findOne = jest.fn(async () => null);
    const query = jest.fn(async () => []);
    const em = {
      query,
      getRepository: jest.fn(() => ({ findOne })),
    } as unknown as EntityManager;

    await expect(findDeadMansSwitchForUpdate(em, 'owner-1', true)).resolves.toBeNull();

    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['dead-mans-switch:owner-1'],
    );
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(findOne.mock.invocationCallOrder[0]);
    expect(findOne).toHaveBeenCalledWith({
      where: { userId: 'owner-1' },
      lock: { mode: 'pessimistic_write' },
    });
  });
});
