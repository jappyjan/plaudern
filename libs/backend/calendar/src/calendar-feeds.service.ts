import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  CalendarFeedDto,
  CalendarSyncStatus,
  CreateCalendarFeedRequest,
  UpdateCalendarFeedRequest,
} from '@plaudern/contracts';
import { CalendarFeedEntity, decryptSecret, encryptSecret } from '@plaudern/persistence';
import type { GoogleCalendarSummary } from './google/google-calendar.client';
import { maskFeedUrl, normalizeFeedUrl } from './ics/ics-feed.client';

/**
 * Owns calendar feed rows, each belonging to exactly one user. Feed URLs are
 * secrets: stored AES-encrypted, deduped via a sha256 hash, and only ever
 * exposed masked.
 */
@Injectable()
export class CalendarFeedsService {
  constructor(
    @InjectRepository(CalendarFeedEntity)
    private readonly repo: Repository<CalendarFeedEntity>,
    private readonly config: ConfigService,
  ) {}

  list(userId: string): Promise<CalendarFeedEntity[]> {
    return this.repo.find({ where: { userId }, order: { createdAt: 'ASC' } });
  }

  /** Enabled feeds of one user, or of every user (the sync scheduler). */
  listEnabled(userId?: string): Promise<CalendarFeedEntity[]> {
    return this.repo.find({
      where: userId ? { userId, enabled: true } : { enabled: true },
      order: { createdAt: 'ASC' },
    });
  }

  async getEntity(userId: string, id: string): Promise<CalendarFeedEntity> {
    const feed = await this.repo.findOne({ where: { id, userId } });
    if (!feed) throw new NotFoundException('calendar feed not found');
    return feed;
  }

  async create(userId: string, req: CreateCalendarFeedRequest): Promise<CalendarFeedEntity> {
    const secret = this.requireSecret();
    const url = normalizeFeedUrl(req.url);
    const urlHash = hashUrl(url);
    const duplicate = await this.repo.findOne({ where: { userId, urlHash } });
    if (duplicate) {
      throw new ConflictException(`this feed is already subscribed as "${duplicate.name}"`);
    }
    const created = this.repo.create({
      userId,
      name: req.name,
      providerType: 'ics',
      urlEncrypted: encryptSecret(url, secret),
      urlHash,
      urlMasked: maskFeedUrl(url),
      color: req.color ?? null,
      enabled: req.enabled,
      autoLink: req.autoLink ?? false,
    });
    return this.repo.save(created);
  }

  async update(
    userId: string,
    id: string,
    req: UpdateCalendarFeedRequest,
  ): Promise<CalendarFeedEntity> {
    const feed = await this.getEntity(userId, id);
    if (req.name !== undefined) feed.name = req.name;
    if (req.color !== undefined) feed.color = req.color;
    if (req.enabled !== undefined) feed.enabled = req.enabled;
    if (req.autoLink !== undefined) feed.autoLink = req.autoLink;
    if (req.url !== undefined) {
      const secret = this.requireSecret();
      const url = normalizeFeedUrl(req.url);
      const urlHash = hashUrl(url);
      const duplicate = await this.repo.findOne({ where: { userId, urlHash } });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`this feed is already subscribed as "${duplicate.name}"`);
      }
      feed.urlEncrypted = encryptSecret(url, secret);
      feed.urlHash = urlHash;
      feed.urlMasked = maskFeedUrl(url);
      // The URL points somewhere new — previous sync status is meaningless.
      feed.lastSyncAt = null;
      feed.lastSyncStatus = null;
      feed.lastSyncError = null;
      feed.lastSyncEventCount = null;
    }
    return this.repo.save(feed);
  }

  async remove(userId: string, id: string): Promise<void> {
    const feed = await this.getEntity(userId, id);
    // Events (and their links) go with the feed via FK cascades.
    await this.repo.remove(feed);
  }

  getDecryptedUrl(feed: CalendarFeedEntity): string {
    try {
      return decryptSecret(feed.urlEncrypted ?? '', this.requireSecret());
    } catch {
      throw new Error(
        'stored feed URL cannot be decrypted (APP_ENCRYPTION_SECRET missing or changed) — re-enter the feed URL in settings',
      );
    }
  }

  /** Create one feed row per selected Google calendar. Skips calendars already
   *  subscribed for this account. `ponytail:` the refresh token is duplicated
   *  across rows — fine single-user; a google_connections table if multi-account. */
  async createGoogleFeeds(
    userId: string,
    input: {
      email: string;
      refreshToken: string;
      calendars: GoogleCalendarSummary[];
    },
  ): Promise<CalendarFeedEntity[]> {
    const secret = this.requireSecret();
    const encrypted = encryptSecret(input.refreshToken, secret);
    const existing = await this.repo.find({
      where: { userId, googleAccountEmail: input.email },
    });
    const already = new Set(existing.map((f) => f.googleCalendarId));
    const created: CalendarFeedEntity[] = [];
    for (const cal of input.calendars) {
      if (already.has(cal.id)) continue;
      const feed = await this.repo.save(
        this.repo.create({
          userId,
          name: cal.summary,
          providerType: 'google',
          urlEncrypted: null,
          urlHash: null,
          urlMasked: `${input.email} · ${cal.summary}`,
          googleCalendarId: cal.id,
          googleAccountEmail: input.email,
          googleRefreshTokenEncrypted: encrypted,
          color: null,
          enabled: true,
          autoLink: false,
        }),
      );
      created.push(feed);
    }
    return created;
  }

  /** Reconnect: re-encrypt the refresh token on every feed for an account and
   *  clear any error state so the next sync retries. Returns rows updated. */
  async updateGoogleRefreshToken(
    userId: string,
    email: string,
    refreshToken: string,
  ): Promise<number> {
    const secret = this.requireSecret();
    const encrypted = encryptSecret(refreshToken, secret);
    const feeds = await this.repo.find({
      where: { userId, googleAccountEmail: email },
    });
    for (const feed of feeds) {
      feed.googleRefreshTokenEncrypted = encrypted;
      feed.lastSyncStatus = null;
      feed.lastSyncError = null;
      await this.repo.save(feed);
    }
    return feeds.length;
  }

  getDecryptedRefreshToken(feed: CalendarFeedEntity): string {
    if (!feed.googleRefreshTokenEncrypted) {
      throw new Error('google feed has no stored refresh token — reconnect in settings');
    }
    try {
      return decryptSecret(feed.googleRefreshTokenEncrypted, this.requireSecret());
    } catch {
      throw new Error(
        'stored google token cannot be decrypted (APP_ENCRYPTION_SECRET missing or changed) — reconnect in settings',
      );
    }
  }

  async recordSyncResult(
    id: string,
    result: { status: CalendarSyncStatus; error?: string | null; eventCount?: number | null },
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: result.status,
        lastSyncError: result.error ?? null,
        lastSyncEventCount: result.eventCount ?? null,
      },
    );
  }

  toDto(feed: CalendarFeedEntity): CalendarFeedDto {
    return {
      id: feed.id,
      name: feed.name,
      providerType: feed.providerType,
      enabled: feed.enabled,
      autoLink: feed.autoLink,
      color: feed.color,
      urlMasked: feed.urlMasked ?? '',
      lastSyncAt: feed.lastSyncAt,
      lastSyncStatus: feed.lastSyncStatus,
      lastSyncError: feed.lastSyncError,
      lastSyncEventCount: feed.lastSyncEventCount,
    };
  }

  private requireSecret(): string {
    const secret = this.config.get<string>('APP_ENCRYPTION_SECRET', '');
    if (!secret) {
      throw new BadRequestException(
        'APP_ENCRYPTION_SECRET is not configured on the server — set it to enable calendar feed storage',
      );
    }
    return secret;
  }
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}
