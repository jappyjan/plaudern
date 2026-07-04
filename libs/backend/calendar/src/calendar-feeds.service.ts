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
import { CalendarFeedEntity } from '@plaudern/persistence';
import { decryptSecret, encryptSecret } from '@plaudern/persistence';
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
      return decryptSecret(feed.urlEncrypted, this.requireSecret());
    } catch {
      throw new Error(
        'stored feed URL cannot be decrypted (APP_ENCRYPTION_SECRET missing or changed) — re-enter the feed URL in settings',
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
      urlMasked: feed.urlMasked,
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
