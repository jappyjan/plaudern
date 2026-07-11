import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AccountExport } from '@plaudern/contracts';
import type { NotificationsService } from '@plaudern/notifications';
import {
  ALL_ENTITIES,
  DeadMansSwitchEntity,
  DeadMansSwitchReleaseEntity,
} from '@plaudern/persistence';
import type { DataSovereigntyService } from './data-sovereignty.service';
import { DeadMansSwitchReleaseService } from './dead-mans-switch-release.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-06T12:00:00.000Z');
const USER = 'owner-1';
const CONTACT = 'trusted@example.com';

/** A fake export so `resolveEmergencyAccess` has something to return. */
const FAKE_EXPORT = { schemaVersion: 1, userId: USER, itemCount: 0, items: [] } as unknown as AccountExport;

function makeConfig(graceDays: string): ConfigService {
  return {
    get: (key: string, def?: string) => {
      if (key === 'DEAD_MANS_SWITCH_GRACE_DAYS') return graceDays;
      if (key === 'PUBLIC_APP_URL') return 'https://app.test';
      return def;
    },
  } as unknown as ConfigService;
}

/** Pull the raw token out of the emergency-access link the contact was emailed. */
function tokenFromEmail(notify: jest.Mock): string {
  const url = notify.mock.calls[0][1].url as string;
  return url.substring(url.lastIndexOf('/') + 1);
}

describe('DeadMansSwitchReleaseService', () => {
  let dataSource: DataSource;
  let notifications: {
    notify: jest.Mock;
    notifyEmailAddress: jest.Mock;
  };
  let sovereignty: { exportEverything: jest.Mock };

  async function seedSwitch(overrides: Partial<DeadMansSwitchEntity>): Promise<void> {
    const repo = dataSource.getRepository(DeadMansSwitchEntity);
    await repo.save(
      repo.create({
        userId: USER,
        enabled: true,
        contactEmail: CONTACT,
        checkInIntervalDays: 90,
        lastCheckInAt: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
        ...overrides,
      }),
    );
  }

  function makeService(graceDays = '0'): DeadMansSwitchReleaseService {
    return new DeadMansSwitchReleaseService(
      dataSource,
      makeConfig(graceDays),
      notifications as unknown as NotificationsService,
      sovereignty as unknown as DataSovereigntyService,
    );
  }

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    notifications = {
      notify: jest.fn(async () => ({ outcome: 'sent' })),
      notifyEmailAddress: jest.fn(async () => ({ sent: true, detail: CONTACT })),
    };
    sovereignty = { exportEverything: jest.fn(async () => FAKE_EXPORT) };
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('fires exactly once on a lapsed check-in and grants scoped access', async () => {
    await seedSwitch({}); // last check-in 100d ago, interval 90d → lapsed.
    const service = makeService('0'); // no grace window: arm + grant in one sweep.

    const grantedFirst = await service.sweepUser(USER, NOW);
    expect(grantedFirst).toBe(1);
    expect(notifications.notifyEmailAddress).toHaveBeenCalledTimes(1);
    expect(notifications.notifyEmailAddress.mock.calls[0][0]).toBe(CONTACT);

    const releases = await dataSource.getRepository(DeadMansSwitchReleaseEntity).find();
    expect(releases).toHaveLength(1);
    expect(releases[0].status).toBe('active');
    expect(releases[0].tokenHash).toBeTruthy();
    expect(releases[0].contactEmail).toBe(CONTACT);

    // The contact can resolve their token to the owner's export.
    const token = tokenFromEmail(notifications.notifyEmailAddress);
    const bundle = await service.resolveEmergencyAccess(token);
    expect(bundle).toBe(FAKE_EXPORT);
    expect(sovereignty.exportEverything).toHaveBeenCalledWith(USER);

    // Already released → a second sweep does NOT re-fire.
    const grantedSecond = await service.sweepUser(USER, new Date(NOW.getTime() + DAY_MS));
    expect(grantedSecond).toBe(0);
    expect(notifications.notifyEmailAddress).toHaveBeenCalledTimes(1);
    expect(await dataSource.getRepository(DeadMansSwitchReleaseEntity).count()).toBe(1);
  });

  it('does not fire when the check-in has not lapsed (re-check-in before triggersAt)', async () => {
    await seedSwitch({ lastCheckInAt: NOW.toISOString() }); // just checked in.
    const service = makeService('0');

    const granted = await service.sweepUser(USER, NOW);
    expect(granted).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.notifyEmailAddress).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(DeadMansSwitchReleaseEntity).count()).toBe(0);
  });

  it('cancels a grace-window release when the owner re-checks in before it grants', async () => {
    await seedSwitch({}); // lapsed.
    const service = makeService('10'); // 10-day grace window.

    // First sweep ARMS a pending release but does not grant yet.
    const granted = await service.sweepUser(USER, NOW);
    expect(granted).toBe(0);
    expect(notifications.notify).toHaveBeenCalledTimes(1); // owner warned.
    expect(notifications.notifyEmailAddress).not.toHaveBeenCalled(); // contact NOT yet.
    let releases = await dataSource.getRepository(DeadMansSwitchReleaseEntity).find();
    expect(releases[0].status).toBe('pending');

    // Owner re-checks in (controller resets lastCheckInAt + cancels pending).
    await dataSource
      .getRepository(DeadMansSwitchEntity)
      .update({ userId: USER }, { lastCheckInAt: NOW.toISOString() });
    const cancelled = await service.cancelPendingReleases(USER, NOW);
    expect(cancelled).toBe(1);

    // A later sweep (still within the would-be window) does NOT grant.
    const grantedAfter = await service.sweepUser(USER, new Date(NOW.getTime() + 20 * DAY_MS));
    expect(grantedAfter).toBe(0);
    expect(notifications.notifyEmailAddress).not.toHaveBeenCalled();
    releases = await dataSource.getRepository(DeadMansSwitchReleaseEntity).find();
    expect(releases).toHaveLength(1);
    expect(releases[0].status).toBe('cancelled');
  });

  it('lets the owner revoke a granted release so the token stops resolving', async () => {
    await seedSwitch({});
    const service = makeService('0');
    await service.sweepUser(USER, NOW);
    const token = tokenFromEmail(notifications.notifyEmailAddress);
    const release = (await dataSource.getRepository(DeadMansSwitchReleaseEntity).find())[0];

    // Token resolves before revoke.
    expect(await service.resolveEmergencyAccess(token)).toBe(FAKE_EXPORT);

    const dto = await service.revokeRelease(USER, release.id, NOW);
    expect(dto.status).toBe('revoked');

    // After revoke the grant is gone: token no longer resolves.
    expect(await service.resolveEmergencyAccess(token)).toBeNull();
    const after = (await dataSource.getRepository(DeadMansSwitchReleaseEntity).find())[0];
    expect(after.status).toBe('revoked');
    expect(after.tokenHash).toBeNull();
  });

  it('does not resurrect a cancelled release into a grant (F2/F3 lost-update race)', async () => {
    await seedSwitch({}); // lapsed.
    const service = makeService('10'); // 10-day grace: first sweep only ARMs.
    await service.sweepUser(USER, NOW);

    const origGetRepo = dataSource.getRepository.bind(dataSource);
    const releaseRepo = origGetRepo(DeadMansSwitchReleaseEntity);
    // Snapshot the release WHILE it is still pending (models the sweep's read).
    const stalePending = { ...(await releaseRepo.findOne({ where: { userId: USER } }))! };
    expect(stalePending.status).toBe('pending');

    // The owner's check-in lands FIRST and cancels the row in the DB.
    await releaseRepo.update(
      { id: stalePending.id },
      { status: 'cancelled', closedAt: NOW.toISOString() },
    );

    // Now the sweep's write executes against the DB — but it still holds the
    // stale pending snapshot. Feed that snapshot in and let every real write hit
    // the cancelled row. The conditional flip must find no pending row.
    jest.spyOn(releaseRepo, 'findOne').mockResolvedValueOnce(stalePending as never);
    jest
      .spyOn(dataSource, 'getRepository')
      .mockImplementation(((target: unknown) =>
        target === DeadMansSwitchReleaseEntity
          ? releaseRepo
          : origGetRepo(target as never)) as typeof dataSource.getRepository);

    const later = new Date(NOW.getTime() + 20 * DAY_MS); // grace elapsed.
    const granted = await service.sweepUser(USER, later);

    // The lost update is prevented: no grant, no token, no contact email, and the
    // release stays cancelled — the "re-check-in cancels" invariant holds.
    expect(granted).toBe(0);
    expect(notifications.notifyEmailAddress).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    const row = (await dataSource.getRepository(DeadMansSwitchReleaseEntity).find())[0];
    expect(row.status).toBe('cancelled');
    expect(row.tokenHash).toBeNull();
  });
});
