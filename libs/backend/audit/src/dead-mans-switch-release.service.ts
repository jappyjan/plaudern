import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Not } from 'typeorm';
import type {
  AccountExport,
  DeadMansSwitchReleaseDto,
  DeadMansSwitchReleaseStatus,
} from '@plaudern/contracts';
import { NotificationsService } from '@plaudern/notifications';
import {
  DeadMansSwitchEntity,
  DeadMansSwitchReleaseEntity,
} from '@plaudern/persistence';
import { DataSovereigntyService } from './data-sovereignty.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default grace/confirmation window before a tripped switch grants access. */
const DEFAULT_GRACE_DAYS = 7;
/** Statuses a release can no longer transition out of. */
const TERMINAL: DeadMansSwitchReleaseStatus[] = ['cancelled', 'revoked'];

/**
 * The dead-man's-switch RELEASE mechanism (JJ-80) — the follow-up that makes the
 * JJ-42 scaffold actually fire. `DataSovereigntyService` owns the owner's INTENT
 * (`dead_mans_switch`: trusted contact + check-in interval); this service owns
 * every ACTUAL firing (`dead_mans_switch_release`).
 *
 * Firing is deliberately two-phase, so incapacity is distinguished from a missed
 * ping and the owner always gets a last word:
 *
 *  1. ARM — a sweep finds a lapsed check-in (now > triggersAt) on an enabled,
 *     configured switch with no live release, so it writes a `pending` release,
 *     opens a grace/confirmation window, and notifies the OWNER (audited/gated
 *     notification engine). A re-check-in during the window cancels it
 *     (`cancelPendingReleases`, called on check-in).
 *  2. GRANT — a later sweep finds the grace window elapsed with the release still
 *     `pending`, so it mints a single scoped token, flips the release to
 *     `active`, and emails the trusted CONTACT the access link.
 *
 * Auth/consent scope of the grant: a SINGLE, read-only credential to the owner's
 * export bundle (`exportEverything`) and nothing else — no write, no delete, no
 * login. Only the SHA-256 of the token is stored, so the raw credential exists
 * only in the contact's inbox. The owner can `revoke` an active grant at any
 * time. Firing is idempotent: once a release exists for a lapse it never
 * re-arms and the contact is emailed exactly once.
 *
 * A revoke (F1, JJ-80 review) durably disarms the switch for the lapse that
 * produced it: `revokeRelease` also marks the switch (`armingSuspendedForCheckInAt`)
 * so a still-lapsed switch does NOT arm a fresh release and re-warn the owner
 * on the next sweep. Only a genuine check-in — which changes `lastCheckInAt` —
 * lifts the suppression and lets a later lapse arm normally.
 *
 * Editing the switch's contact (F4) refreshes any still-`pending` release's
 * snapshot (`syncPendingContactSnapshot`) so a grace-window grant always goes
 * to the CURRENT contact, never a stale one. Disabling the switch (F7) fully
 * stands it down (`disarmForDisable`): cancels any pending release and revokes
 * any active grant, rather than merely pausing new firings.
 *
 * No construction cycle: this service depends on `DataSovereigntyService` (for
 * the export) one-directionally; the reverse coupling (cancel-on-check-in,
 * contact-sync-on-edit, disarm-on-disable) is composed at the controller, so
 * neither service injects the other's owner.
 */
@Injectable()
export class DeadMansSwitchReleaseService {
  private readonly logger = new Logger(DeadMansSwitchReleaseService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly sovereignty: DataSovereigntyService,
  ) {}

  /** Owner ids whose switch is armed (enabled + configured + has checked in). */
  async userIdsWithArmedSwitches(): Promise<string[]> {
    const rows: Array<{ userId: string }> = await this.dataSource
      .getRepository(DeadMansSwitchEntity)
      .createQueryBuilder('s')
      .select('s.userId', 'userId')
      .where('s.enabled = :enabled', { enabled: true })
      .andWhere('s.contactEmail IS NOT NULL')
      .andWhere('s.lastCheckInAt IS NOT NULL')
      .getRawMany();
    return rows.map((r) => r.userId);
  }

  /**
   * Advance one user's switch by one tick. Returns the number of NEW grants made
   * (0 or 1). Safe to call repeatedly: it arms once, grants once, and no-ops
   * thereafter. `now` is injectable for tests.
   */
  async sweepUser(userId: string, now = new Date()): Promise<number> {
    const sw = await this.dataSource
      .getRepository(DeadMansSwitchEntity)
      .findOne({ where: { userId } });
    // Disabling the switch only stops NEW firings HERE — it does not itself
    // revoke a grant that already went `active`. That side effect is handled
    // explicitly (F7, `disarmForDisable`), called by the controller the
    // moment the owner flips the switch off, so an already-disabled switch
    // never has a live grant to revoke by the time we get here.
    if (!sw || !sw.enabled || !sw.contactEmail || !sw.lastCheckInAt) return 0;

    const triggersAt = Date.parse(sw.lastCheckInAt) + sw.checkInIntervalDays * DAY_MS;
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);
    // Only a non-terminal (pending/active) release blocks re-firing. F1: a
    // `revoked` release also sets `armingSuspendedForCheckInAt` (below), so a
    // still-lapsed switch does NOT arm a fresh release until a real check-in
    // moves `lastCheckInAt` forward. A plain `cancelled` (re-check-in) release
    // does not set the marker — the switch is no longer lapsed at that point.
    let release = await releases.findOne({
      where: { userId, status: Not(In(TERMINAL)) },
    });

    // Not yet lapsed: if a grace-window release is open the owner has effectively
    // returned (check-in moved triggersAt into the future) — cancel it so nothing
    // fires. Nothing else to do.
    if (now.getTime() < triggersAt) {
      if (release && release.status === 'pending') {
        release.status = 'cancelled';
        release.closedAt = now.toISOString();
        await releases.save(release);
        this.logger.log(`dms: cancelled pending release for ${userId} (re-check-in)`);
      }
      return 0;
    }

    // Lapsed. ARM: create the pending release + open the grace window + tell owner.
    if (!release) {
      // F1: a revoke suppresses re-arming for THIS lapse — `lastCheckInAt`
      // hasn't moved since the revoke, so do not create a new pending release
      // (and re-warn the owner) until a fresh check-in advances it.
      if (
        sw.armingSuspendedForCheckInAt !== null &&
        sw.armingSuspendedForCheckInAt === sw.lastCheckInAt
      ) {
        return 0;
      }
      const graceMs = this.graceDays() * DAY_MS;
      release = releases.create({
        userId,
        contactEmail: sw.contactEmail,
        status: 'pending',
        tokenHash: null,
        firedAt: now.toISOString(),
        graceUntil: new Date(now.getTime() + graceMs).toISOString(),
        grantedAt: null,
        closedAt: null,
      });
      release = await releases.save(release);
      await this.notifyOwnerArmed(userId, release);
      this.logger.warn(
        `dms: armed release ${release.id} for ${userId}; grace until ${release.graceUntil}`,
      );
    }

    // GRANT: grace elapsed and still pending → hand the contact scoped access.
    if (release.status === 'pending' && now.getTime() >= Date.parse(release.graceUntil)) {
      const token = randomBytes(32).toString('hex');
      // CONDITIONAL flip: the advisory lock serializes sweeps but NOT the owner's
      // check-in write, so between our read and this write a `cancelPendingReleases`
      // may have flipped the row to `cancelled`. Guard the transition on
      // `status = 'pending'` so a lost update can't resurrect a cancelled release
      // into an active grant — the "re-check-in cancels" invariant must hold no
      // matter who raced. Only mint/email when we actually won the row.
      const result = await releases
        .createQueryBuilder()
        .update()
        .set({ status: 'active', tokenHash: hashToken(token), grantedAt: now.toISOString() })
        .where('id = :id AND status = :status', { id: release.id, status: 'pending' })
        .execute();
      if (result.affected !== 1) {
        this.logger.log(`dms: release ${release.id} no longer pending — grant skipped (raced)`);
        return 0;
      }
      release.status = 'active';
      release.tokenHash = hashToken(token);
      release.grantedAt = now.toISOString();
      await this.notifyContactGranted(release, token);
      await this.notifyOwnerReleased(userId, release);
      this.logger.warn(`dms: granted release ${release.id} to ${release.contactEmail}`);
      return 1;
    }
    return 0;
  }

  /**
   * Cancel any grace-window (`pending`) release for the owner. Called when the
   * owner checks in: a return before the grant fires must stop the release. An
   * already-`active` grant is untouched — that requires an explicit `revoke`.
   */
  async cancelPendingReleases(userId: string, now = new Date()): Promise<number> {
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const pending = await releases.find({ where: { userId, status: 'pending' } });
    for (const r of pending) {
      r.status = 'cancelled';
      r.closedAt = now.toISOString();
    }
    if (pending.length > 0) await releases.save(pending);
    return pending.length;
  }

  /**
   * Owner revokes an active (or still-pending) grant: the token stops
   * resolving immediately. F1: this also durably disarms the switch for the
   * CURRENT lapse — without it, the next sweep would arm a brand-new pending
   * release for the same still-lapsed check-in and re-warn the owner. Normal
   * arming resumes only after a fresh check-in.
   */
  async revokeRelease(
    userId: string,
    releaseId: string,
    now = new Date(),
  ): Promise<DeadMansSwitchReleaseDto> {
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const release = await releases.findOne({ where: { id: releaseId } });
    if (!release) throw new NotFoundException('release not found');
    if (release.userId !== userId) throw new ForbiddenException('not your release');
    if (release.status === 'active' || release.status === 'pending') {
      release.status = 'revoked';
      release.tokenHash = null; // the credential can no longer resolve.
      release.closedAt = now.toISOString();
      await releases.save(release);
      await this.suppressArmingForCurrentLapse(userId);
      this.logger.warn(`dms: owner ${userId} revoked release ${releaseId}`);
    }
    return toReleaseDto(release);
  }

  /**
   * F4: refresh the fire-time contact snapshot on any still-open (`pending`)
   * release when the owner edits the switch's contact. Without this, editing
   * the contact mid-grace-window keeps the STALE snapshot, so the OLD contact
   * — not the one the owner just configured — would be the one granted access
   * when the window elapses. An already-`active` grant already went out to the
   * contact it named, so it is intentionally left alone.
   */
  async syncPendingContactSnapshot(userId: string, contactEmail: string | null): Promise<void> {
    if (!contactEmail) return; // the release's contactEmail column is non-nullable.
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);
    const result = await releases
      .createQueryBuilder()
      .update()
      .set({ contactEmail })
      .where('userId = :userId AND status = :status', { userId, status: 'pending' })
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.logger.log(`dms: refreshed pending release contact snapshot for ${userId}`);
    }
  }

  /**
   * F7: disabling the switch must fully stand it down — not just stop new
   * firings. Cancels any grace-window release and revokes any already-active
   * grant (mirroring the owner's explicit `revokeRelease`, including the F1
   * arm-suppression so re-enabling later does not immediately re-arm off a
   * stale, already-handled lapse).
   */
  async disarmForDisable(userId: string, now = new Date()): Promise<void> {
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);

    // CONDITIONAL flip, not save()-by-PK: a concurrent sweep may promote this
    // release pending→active at grace expiry between our read and our write —
    // a blind save would clobber that ACTIVE grant back to 'cancelled' with
    // stale fields (and leave a minted token at large while the row claims
    // cancelled). Guarding on status='pending' means a lost race is simply a
    // miss here, and the active-revoke pass below (a FRESH query, so it sees
    // the just-promoted row) revokes the grant properly instead.
    const cancelResult = await releases
      .createQueryBuilder()
      .update()
      .set({ status: 'cancelled', closedAt: now.toISOString() })
      .where('userId = :userId AND status = :status', { userId, status: 'pending' })
      .execute();
    const cancelledCount = cancelResult.affected ?? 0;

    const active = await releases.find({ where: { userId, status: 'active' } });
    let revokedCount = 0;
    for (const r of active) {
      // Conditional flip, same guard as the sweep's grant transition: only
      // count/act on rows we actually won.
      const result = await releases
        .createQueryBuilder()
        .update()
        .set({ status: 'revoked', tokenHash: null, closedAt: now.toISOString() })
        .where('id = :id AND status = :status', { id: r.id, status: 'active' })
        .execute();
      if (result.affected === 1) revokedCount += 1;
    }

    // F1 suppression whenever ANYTHING was stood down — a disable that only
    // cancelled a pending release must not re-arm + re-warn immediately on
    // re-enable while the same stale lapse persists, exactly like a revoke.
    if (cancelledCount + revokedCount > 0) {
      await this.suppressArmingForCurrentLapse(userId);
      this.logger.warn(
        `dms: disable disarmed switch for ${userId} (${cancelledCount} cancelled, ${revokedCount} revoked)`,
      );
    }
  }

  /**
   * F1: mark the switch so the CURRENT lapse cannot arm a new release. Stores
   * `lastCheckInAt` as of the revoke; `sweepUser` skips arming while this
   * still matches `lastCheckInAt` (no check-in since). A real check-in
   * changes (and clears) `lastCheckInAt`, so the marker goes stale on its own
   * and the next lapse arms normally.
   */
  private async suppressArmingForCurrentLapse(userId: string): Promise<void> {
    const switches = this.dataSource.getRepository(DeadMansSwitchEntity);
    const sw = await switches.findOne({ where: { userId } });
    if (!sw) return;
    await switches.update({ userId }, { armingSuspendedForCheckInAt: sw.lastCheckInAt });
  }

  /** The owner's release history (newest first) for the sovereignty surface. */
  async listReleases(userId: string): Promise<DeadMansSwitchReleaseDto[]> {
    const rows = await this.dataSource
      .getRepository(DeadMansSwitchReleaseEntity)
      .find({ where: { userId }, order: { firedAt: 'DESC' } });
    return rows.map(toReleaseDto);
  }

  /**
   * Resolve an emergency-access token to the granted archive export. Returns null
   * for any token that does not match a currently-`active`, non-revoked grant —
   * the ONLY capability the token confers is read-only export of that one owner.
   */
  async resolveEmergencyAccess(token: string): Promise<AccountExport | null> {
    if (!token) return null;
    const release = await this.dataSource
      .getRepository(DeadMansSwitchReleaseEntity)
      .findOne({ where: { tokenHash: hashToken(token), status: 'active' } });
    if (!release) return null;
    return this.sovereignty.exportEverything(release.userId);
  }

  private graceDays(): number {
    const raw = this.config.get<string>('DEAD_MANS_SWITCH_GRACE_DAYS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GRACE_DAYS;
  }

  /** Owner: the switch tripped; here is the grace window to cancel it. */
  private async notifyOwnerArmed(userId: string, r: DeadMansSwitchReleaseEntity): Promise<void> {
    const when = new Date(r.graceUntil).toUTCString();
    await this.notifications.notify(userId, {
      category: 'dead_mans_switch',
      title: 'Your emergency-access switch is about to release',
      body: `No check-in was recorded, so unless you check in before ${when}, ${r.contactEmail} will be granted read-only emergency access to your archive.`,
      url: '/settings/data',
      data: { releaseId: r.id, phase: 'armed' },
    });
  }

  /** Owner: the grant just went out (so they can revoke if it was a mistake). */
  private async notifyOwnerReleased(userId: string, r: DeadMansSwitchReleaseEntity): Promise<void> {
    await this.notifications.notify(userId, {
      category: 'dead_mans_switch',
      title: 'Emergency access to your archive was granted',
      body: `${r.contactEmail} was just granted read-only emergency access to your archive. If this was not intended, you can revoke it in your data settings.`,
      url: '/settings/data',
      data: { releaseId: r.id, phase: 'released' },
    });
  }

  /** Contact: the scoped access link (raw token, sent exactly once). */
  private async notifyContactGranted(r: DeadMansSwitchReleaseEntity, token: string): Promise<void> {
    const base = (this.config.get<string>('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');
    const link = `${base}/api/v1/account/emergency-access/${token}`;
    await this.notifications.notifyEmailAddress(r.contactEmail, {
      title: 'Emergency access to a Plaudern archive',
      body: `You were named as a trusted contact for a Plaudern archive. Its owner has not checked in, so you have been granted read-only emergency access. This link is a private credential — do not share it.`,
      url: link,
    });
  }
}

/** SHA-256 hex of a token; the raw token is never persisted. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toReleaseDto(r: DeadMansSwitchReleaseEntity): DeadMansSwitchReleaseDto {
  return {
    id: r.id,
    contactEmail: r.contactEmail,
    status: r.status,
    firedAt: new Date(r.firedAt).toISOString(),
    graceUntil: new Date(r.graceUntil).toISOString(),
    grantedAt: r.grantedAt ? new Date(r.grantedAt).toISOString() : null,
    closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
  };
}
