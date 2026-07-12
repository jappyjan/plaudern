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

  it(
    'F1: a revoke suppresses re-arming for the same lapse; a fresh check-in ' +
      'and a new lapse arm normally again',
    async () => {
      await seedSwitch({}); // lapsed 100d ago, interval 90d.
      const service = makeService('0'); // arm + grant in one sweep.

      // Lapse → arm (+ grant, since grace=0).
      expect(await service.sweepUser(USER, NOW)).toBe(1);
      const releaseRepo = dataSource.getRepository(DeadMansSwitchReleaseEntity);
      const first = (await releaseRepo.find())[0];
      expect(first.status).toBe('active');

      // Revoke, while the switch is STILL lapsed (no check-in happened).
      const dto = await service.revokeRelease(USER, first.id, NOW);
      expect(dto.status).toBe('revoked');
      const switches = dataSource.getRepository(DeadMansSwitchEntity);
      const swAfterRevoke = await switches.findOne({ where: { userId: USER } });
      expect(swAfterRevoke!.armingSuspendedForCheckInAt).toBe(swAfterRevoke!.lastCheckInAt);

      // Sweep again: NO re-arm, NO re-notify, for the same lapse.
      notifications.notify.mockClear();
      notifications.notifyEmailAddress.mockClear();
      expect(await service.sweepUser(USER, new Date(NOW.getTime() + DAY_MS))).toBe(0);
      expect(await releaseRepo.count()).toBe(1); // no new pending release.
      expect(notifications.notify).not.toHaveBeenCalled();
      expect(notifications.notifyEmailAddress).not.toHaveBeenCalled();

      // Owner checks in — lifts the suppression (mirrors
      // DataSovereigntyService#checkInDeadMansSwitch).
      const checkInAt = new Date(NOW.getTime() + 2 * DAY_MS);
      await switches.update(
        { userId: USER },
        { lastCheckInAt: checkInAt.toISOString(), armingSuspendedForCheckInAt: null },
      );

      // A NEW lapse (90 days after the fresh check-in) arms normally again.
      const newLapse = new Date(checkInAt.getTime() + 91 * DAY_MS);
      expect(await service.sweepUser(USER, newLapse)).toBe(1);
      const rows = await releaseRepo.find();
      expect(rows).toHaveLength(2);
      const second = rows.find((r) => r.id !== first.id)!;
      expect(second.status).toBe('active');
      expect(notifications.notifyEmailAddress).toHaveBeenCalledTimes(1);
    },
  );

  it("F4: refreshes a pending release's contact snapshot but leaves an active grant's snapshot alone", async () => {
    await seedSwitch({});
    const service = makeService('10'); // grace window stays open (pending).
    await service.sweepUser(USER, NOW);
    const releaseRepo = dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const pending = (await releaseRepo.find())[0];
    expect(pending.status).toBe('pending');

    const NEW_CONTACT = 'new-trusted@example.com';
    await service.syncPendingContactSnapshot(USER, NEW_CONTACT);
    const refreshed = await releaseRepo.findOne({ where: { id: pending.id } });
    expect(refreshed!.contactEmail).toBe(NEW_CONTACT);

    // A null contact (e.g. clearing the field) must not stomp the snapshot —
    // the release's contactEmail column is non-nullable.
    await service.syncPendingContactSnapshot(USER, null);
    const stillSet = await releaseRepo.findOne({ where: { id: pending.id } });
    expect(stillSet!.contactEmail).toBe(NEW_CONTACT);

    // Once the grant goes active, further contact edits do not retarget it —
    // the credential was already emailed to the fire-time contact.
    const grantService = makeService('0');
    await releaseRepo.update({ id: pending.id }, { status: 'active' });
    await grantService.syncPendingContactSnapshot(USER, 'yet-another@example.com');
    const activeRow = await releaseRepo.findOne({ where: { id: pending.id } });
    expect(activeRow!.contactEmail).toBe(NEW_CONTACT);
  });

  it('F7: disarmForDisable cancels a pending release', async () => {
    await seedSwitch({});
    const service = makeService('10'); // pending-only.
    await service.sweepUser(USER, NOW);
    const releaseRepo = dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const pending = (await releaseRepo.find())[0];
    expect(pending.status).toBe('pending');

    await service.disarmForDisable(USER, new Date(NOW.getTime() + DAY_MS));

    const after = await releaseRepo.findOne({ where: { id: pending.id } });
    expect(after!.status).toBe('cancelled');
    expect(after!.closedAt).toBeTruthy();

    // A disable that only cancelled a PENDING release still suppresses arming:
    // re-enabling while the same lapse is stale must not immediately re-arm
    // and re-warn the owner.
    const switches = dataSource.getRepository(DeadMansSwitchEntity);
    const sw = await switches.findOne({ where: { userId: USER } });
    expect(sw!.armingSuspendedForCheckInAt).toBe(sw!.lastCheckInAt);

    // Re-enable + sweep on the same stale lapse: no new release, no warning.
    notifications.notify.mockClear();
    expect(await service.sweepUser(USER, new Date(NOW.getTime() + 2 * DAY_MS))).toBe(0);
    expect(await releaseRepo.count()).toBe(1);
    expect(notifications.notify).not.toHaveBeenCalled();

    // A fresh check-in lifts the suppression; the next lapse arms again
    // (grace=10d in this test → arm only, no grant yet).
    const checkInAt = new Date(NOW.getTime() + 3 * DAY_MS);
    await switches.update(
      { userId: USER },
      { lastCheckInAt: checkInAt.toISOString(), armingSuspendedForCheckInAt: null },
    );
    expect(
      await service.sweepUser(USER, new Date(checkInAt.getTime() + 91 * DAY_MS)),
    ).toBe(0);
    expect(await releaseRepo.count()).toBe(2);
    expect(notifications.notify).toHaveBeenCalledTimes(1); // owner warned for the NEW lapse.
  });

  it('F7: disarmForDisable does not clobber a release a concurrent sweep just promoted to active', async () => {
    await seedSwitch({});
    const service = makeService('10');
    await service.sweepUser(USER, NOW);
    const releaseRepo = dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const release = (await releaseRepo.find())[0];
    expect(release.status).toBe('pending');

    // Model the race: between the disable request landing and its writes, the
    // sweep promotes the release pending→active (grace expired) and mints a
    // token. The conditional cancel must MISS, and the fresh active pass must
    // then revoke the grant properly (token cleared) instead of leaving a live
    // token behind a row that lies 'cancelled'.
    await releaseRepo.update(
      { id: release.id },
      { status: 'active', tokenHash: 'deadbeef', grantedAt: NOW.toISOString() },
    );

    await service.disarmForDisable(USER, new Date(NOW.getTime() + DAY_MS));

    const after = await releaseRepo.findOne({ where: { id: release.id } });
    expect(after!.status).toBe('revoked'); // NOT 'cancelled'.
    expect(after!.tokenHash).toBeNull(); // the credential is dead.
    const sw = await dataSource
      .getRepository(DeadMansSwitchEntity)
      .findOne({ where: { userId: USER } });
    expect(sw!.armingSuspendedForCheckInAt).toBe(sw!.lastCheckInAt);
  });

  it('F7: disarmForDisable revokes an active grant and suppresses re-arming', async () => {
    await seedSwitch({});
    const service = makeService('0'); // arm + grant in one sweep.
    await service.sweepUser(USER, NOW);
    const token = tokenFromEmail(notifications.notifyEmailAddress);
    const releaseRepo = dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const active = (await releaseRepo.find())[0];
    expect(active.status).toBe('active');

    await service.disarmForDisable(USER, new Date(NOW.getTime() + DAY_MS));

    const after = await releaseRepo.findOne({ where: { id: active.id } });
    expect(after!.status).toBe('revoked');
    expect(after!.tokenHash).toBeNull();
    expect(await service.resolveEmergencyAccess(token)).toBeNull();

    // Same F1 invariant applies to a disable-triggered revoke: no re-arm for
    // the same lapse until a fresh check-in.
    notifications.notifyEmailAddress.mockClear();
    expect(await service.sweepUser(USER, new Date(NOW.getTime() + 2 * DAY_MS))).toBe(0);
    expect(await releaseRepo.count()).toBe(1);
    expect(notifications.notifyEmailAddress).not.toHaveBeenCalled();
  });
});
