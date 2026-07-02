import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ALL_ENTITIES, CalendarFeedEntity } from '@plaudern/persistence';
import { CalendarFeedsService } from './calendar-feeds.service';
import { decryptSecret } from './crypto';
import { maskFeedUrl, normalizeFeedUrl } from './ics/ics-feed.client';

describe('normalizeFeedUrl / maskFeedUrl', () => {
  it('rewrites webcal to https', () => {
    expect(normalizeFeedUrl('webcal://example.com/cal.ics')).toBe('https://example.com/cal.ics');
    expect(normalizeFeedUrl('https://example.com/cal.ics')).toBe('https://example.com/cal.ics');
  });

  it('masks the secret path but keeps host and tail', () => {
    const masked = maskFeedUrl(
      'https://calendar.google.com/calendar/ical/private-token-abc123/basic.ics',
    );
    expect(masked).toBe('calendar.google.com/…asic.ics');
    expect(masked).not.toContain('private-token');
  });
});

describe('CalendarFeedsService', () => {
  let dataSource: DataSource;
  let service: CalendarFeedsService;
  let secretValue: string | undefined;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    secretValue = 'app-secret';
    const config = {
      get: (key: string, fallback = '') => {
        if (key === 'APP_ENCRYPTION_SECRET') return secretValue ?? fallback;
        return fallback;
      },
    } as unknown as ConfigService;
    service = new CalendarFeedsService(dataSource.getRepository(CalendarFeedEntity), config);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('creates a feed with an encrypted, masked, hashed URL', async () => {
    const feed = await service.create({
      name: 'Work',
      url: 'webcal://example.com/secret-token/cal.ics',
      enabled: true,
    });
    expect(feed.urlEncrypted).toMatch(/^v1:/);
    expect(feed.urlEncrypted).not.toContain('secret-token');
    expect(feed.urlMasked).toBe('example.com/…/cal.ics');
    expect(feed.urlHash).toMatch(/^[0-9a-f]{64}$/);
    // Decrypts back to the normalized https URL with APP_ENCRYPTION_SECRET.
    expect(decryptSecret(feed.urlEncrypted, 'app-secret')).toBe(
      'https://example.com/secret-token/cal.ics',
    );
    // DTO never exposes the URL.
    const dto = service.toDto(feed);
    expect(JSON.stringify(dto)).not.toContain('secret-token');
  });

  it('rejects when no secret is configured', async () => {
    secretValue = undefined;
    await expect(
      service.create({ name: 'Work', url: 'https://example.com/cal.ics', enabled: true }),
    ).rejects.toThrow(/SECRET/);
  });

  it('rejects a duplicate URL (webcal and https forms collide)', async () => {
    await service.create({ name: 'Work', url: 'https://example.com/cal.ics', enabled: true });
    await expect(
      service.create({ name: 'Copy', url: 'webcal://example.com/cal.ics', enabled: true }),
    ).rejects.toThrow('already subscribed as "Work"');
  });

  it('updating the URL resets sync status', async () => {
    const feed = await service.create({
      name: 'Work',
      url: 'https://example.com/cal.ics',
      enabled: true,
    });
    await service.recordSyncResult(feed.id, { status: 'ok', eventCount: 5 });

    const updated = await service.update(feed.id, { url: 'https://example.com/other.ics' });
    expect(updated.lastSyncStatus).toBeNull();
    expect(updated.lastSyncEventCount).toBeNull();
    expect(decryptSecret(updated.urlEncrypted, 'app-secret')).toBe(
      'https://example.com/other.ics',
    );
  });

  it('updates without url keep the stored URL', async () => {
    const feed = await service.create({
      name: 'Work',
      url: 'https://example.com/cal.ics',
      enabled: true,
    });
    const updated = await service.update(feed.id, { name: 'Renamed', enabled: false });
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.urlEncrypted).toBe(feed.urlEncrypted);
  });
});
