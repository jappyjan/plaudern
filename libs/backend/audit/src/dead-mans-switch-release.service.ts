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
  decryptSecret,
  encryptSecret,
} from '@plaudern/persistence';
import { DataSovereigntyService } from './data-sovereignty.service';
import { findDeadMansSwitchForUpdate } from './dead-mans-switch-lifecycle';

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
 *     notification engine). A re-check-in during the window cancels it in the
 *     same transaction as the new check-in timestamp.
 *  2. GRANT — a later sweep finds the grace window elapsed with the release still
 *     `pending`, so it reserves a single scoped token encrypted at rest, emails
 *     the trusted CONTACT, and flips the release to `active` only after delivery.
 *
 * Auth/consent scope of the grant: a SINGLE, read-only credential to the owner's
 * export bundle (`exportEverything`) and nothing else — no write, no delete, no
 * login. A retryable credential is encrypted with APP_ENCRYPTION_SECRET only
 * until confirmed delivery, then discarded; its SHA-256 hash remains. A crash
 * after send can repeat the same link, but can never mint a second active token.
 *
 * A revoke (F1, JJ-80 review) durably disarms the switch for the lapse that
 * produced it: `revokeRelease` also marks the switch (`armingSuspendedForCheckInAt`)
 * so a still-lapsed switch does NOT arm a fresh release and re-warn the owner
 * on the next sweep. Only a genuine check-in — which changes `lastCheckInAt` —
 * lifts the suppression and lets a later lapse arm normally.
 *
 * Editing the switch's contact refreshes any pending target and invalidates its
 * reserved credential. Disabling fully stands it down: pending releases are
 * cancelled and active grants revoked in the same transaction as the switch.
 *
 * No construction cycle: this service depends on `DataSovereigntyService` only
 * for export. Switch lifecycle invariants live transactionally in that service,
 * behind the audit module seam rather than in the HTTP controller.
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
    const prepared = await this.prepareSweep(userId, now);
    if (!prepared) return 0;
    const { release } = prepared;
    const releases = this.dataSource.getRepository(DeadMansSwitchReleaseEntity);

    if (prepared.armed) {
      await this.notifyOwnerArmed(userId, release);
      this.logger.warn(
        `dms: armed release ${release.id} for ${userId}; grace until ${release.graceUntil}`,
      );
    }

    // GRANT: reserve exactly one retryable credential while still pending, then
    // activate only after the notification adapter confirms delivery.
    if (release.status === 'pending' && now.getTime() >= Date.parse(release.graceUntil)) {
      const credential = await this.reserveCredential(userId, release.id, now);
      if (!credential) {
        this.logger.log(`dms: release ${release.id} no longer pending — grant skipped (raced)`);
        return 0;
      }

      const delivery = await this.notifyContactGranted(credential.release, credential.token);
      if (!delivery.sent) {
        this.logger.warn(
          `dms: contact delivery for release ${release.id} failed; credential retained for retry`,
        );
        return 0;
      }

      // Check-in, disable, or a contact edit may have landed while email was in
      // flight. All invalidate this reservation, so activation is conditional on
      // the exact pending credential and target that were just delivered.
      const activated = await this.activateDeliveredCredential(
        userId,
        credential.release,
        now,
      );
      if (!activated) {
        this.logger.log(`dms: release ${release.id} changed during delivery — grant discarded`);
        return 0;
      }
      release.status = 'active';
      release.tokenHash = credential.release.tokenHash;
      release.tokenEncrypted = null;
      release.grantedAt = now.toISOString();
      try {
        await this.notifyOwnerReleased(userId, release);
      } catch (err) {
        this.logger.error(`dms: owner release notice failed: ${(err as Error).message}`);
      }
      this.logger.warn(`dms: granted release ${release.id} to ${release.contactEmail}`);
      return 1;
    }
    return 0;
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
    return this.dataSource.transaction(async (em) => {
      const sw = await findDeadMansSwitchForUpdate(
        em,
        userId,
        this.dataSource.options.type === 'postgres',
      );
      const releases = em.getRepository(DeadMansSwitchReleaseEntity);
      const release = await releases.findOne({ where: { id: releaseId } });
      if (!release) throw new NotFoundException('release not found');
      if (release.userId !== userId) throw new ForbiddenException('not your release');
      if (release.status === 'active' || release.status === 'pending') {
        release.status = 'revoked';
        release.tokenHash = null;
        release.tokenEncrypted = null;
        release.closedAt = now.toISOString();
        await releases.save(release);
        if (sw) {
          sw.armingSuspendedForCheckInAt = sw.lastCheckInAt;
          await em.getRepository(DeadMansSwitchEntity).save(sw);
        }
        this.logger.warn(`dms: owner ${userId} revoked release ${releaseId}`);
      }
      return toReleaseDto(release);
    });
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

  /** Serialize arming/cancellation with check-in, disable, and contact updates. */
  private async prepareSweep(
    userId: string,
    now: Date,
  ): Promise<{ release: DeadMansSwitchReleaseEntity; armed: boolean } | null> {
    return this.dataSource.transaction(async (em) => {
      const sw = await findDeadMansSwitchForUpdate(
        em,
        userId,
        this.dataSource.options.type === 'postgres',
      );
      if (!sw?.enabled || !sw.contactEmail || !sw.lastCheckInAt) return null;
      const releases = em.getRepository(DeadMansSwitchReleaseEntity);
      let release = await releases.findOne({
        where: { userId, status: Not(In(TERMINAL)) },
      });
      const triggersAt = Date.parse(sw.lastCheckInAt) + sw.checkInIntervalDays * DAY_MS;

      if (now.getTime() < triggersAt) {
        if (release?.status === 'pending') {
          release.status = 'cancelled';
          release.tokenHash = null;
          release.tokenEncrypted = null;
          release.closedAt = now.toISOString();
          await releases.save(release);
          this.logger.log(`dms: cancelled pending release for ${userId} (re-check-in)`);
        }
        return null;
      }

      if (release) return { release, armed: false };
      if (sw.armingSuspendedForCheckInAt === sw.lastCheckInAt) return null;
      const graceMs = this.graceDays() * DAY_MS;
      release = await releases.save(
        releases.create({
          userId,
          contactEmail: sw.contactEmail,
          status: 'pending',
          tokenHash: null,
          tokenEncrypted: null,
          firedAt: now.toISOString(),
          graceUntil: new Date(now.getTime() + graceMs).toISOString(),
          grantedAt: null,
          closedAt: null,
        }),
      );
      return { release, armed: true };
    });
  }

  /** Atomically mint once, or recover the credential reserved by an earlier attempt. */
  private async reserveCredential(
    userId: string,
    releaseId: string,
    now: Date,
  ): Promise<{ release: DeadMansSwitchReleaseEntity; token: string } | null> {
    return this.dataSource.transaction(async (em) => {
      const sw = await findDeadMansSwitchForUpdate(
        em,
        userId,
        this.dataSource.options.type === 'postgres',
      );
      if (!this.canGrant(sw, now)) return null;

      const releases = em.getRepository(DeadMansSwitchReleaseEntity);
      let release = await releases.findOne({ where: { id: releaseId, status: 'pending' } });
      if (!release || release.contactEmail !== sw!.contactEmail) return null;

      if (!release.tokenEncrypted) {
        const token = randomBytes(32).toString('hex');
        const tokenHash = hashToken(token);
        const tokenEncrypted = encryptSecret(token, this.encryptionSecret());
        const result = await releases
          .createQueryBuilder()
          .update()
          .set({ tokenHash, tokenEncrypted })
          .where('id = :id AND status = :status', { id: releaseId, status: 'pending' })
          .andWhere('tokenEncrypted IS NULL')
          .execute();
        if (result.affected === 1) {
          release.tokenHash = tokenHash;
          release.tokenEncrypted = tokenEncrypted;
          return { release, token };
        }
        release = await releases.findOne({ where: { id: releaseId, status: 'pending' } });
        if (!release) return null;
      }

      if (!release.tokenEncrypted || !release.tokenHash) return null;
      return {
        release,
        token: decryptSecret(release.tokenEncrypted, this.encryptionSecret()),
      };
    });
  }

  private async activateDeliveredCredential(
    userId: string,
    release: DeadMansSwitchReleaseEntity,
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      const sw = await findDeadMansSwitchForUpdate(
        em,
        userId,
        this.dataSource.options.type === 'postgres',
      );
      if (!this.canGrant(sw, now) || sw!.contactEmail !== release.contactEmail) return false;
      const result = await em
        .getRepository(DeadMansSwitchReleaseEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'active', tokenEncrypted: null, grantedAt: now.toISOString() })
        .where('id = :id AND status = :status', { id: release.id, status: 'pending' })
        .andWhere('tokenHash = :tokenHash', { tokenHash: release.tokenHash })
        .andWhere('contactEmail = :contactEmail', { contactEmail: release.contactEmail })
        .execute();
      return result.affected === 1;
    });
  }

  private canGrant(sw: DeadMansSwitchEntity | null, now: Date): boolean {
    if (!sw?.enabled || !sw.contactEmail || !sw.lastCheckInAt) return false;
    const triggersAt = Date.parse(sw.lastCheckInAt) + sw.checkInIntervalDays * DAY_MS;
    return now.getTime() >= triggersAt;
  }

  private encryptionSecret(): string {
    const secret = this.config.get<string>('APP_ENCRYPTION_SECRET', '');
    if (!secret) {
      throw new Error(
        'APP_ENCRYPTION_SECRET is not configured - set it to enable emergency-access delivery',
      );
    }
    return secret;
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

  /** Contact: the scoped link; retries may repeat the same credential. */
  private notifyContactGranted(
    r: DeadMansSwitchReleaseEntity,
    token: string,
  ): Promise<{ sent: boolean; detail: string | null }> {
    const base = (this.config.get<string>('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '');
    const link = `${base}/api/v1/account/emergency-access/${token}`;
    return this.notifications.notifyEmailAddress(r.contactEmail, {
      title: 'Emergency access to a Plaudern archive',
      body: `You were named as a trusted contact for a Plaudern archive. Its owner has not checked in, so you have been granted read-only emergency access. This link is a private credential — do not share it.`,
      url: link,
    });
  }
}

/** SHA-256 hex used to resolve a delivered token without decrypting storage. */
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
