import { DataSource, Repository } from 'typeorm';
import type { NotificationChannel } from '@plaudern/contracts';
import {
  ALL_ENTITIES,
  NotificationCategoryPreferenceEntity,
  NotificationDeliveryEntity,
  NotificationSettingsEntity,
  PushSubscriptionEntity,
} from '@plaudern/persistence';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { NotificationsService } from './notifications.service';
import type {
  ChannelSendContext,
  ChannelSendResult,
  NotificationChannelHandler,
  NotificationMessage,
} from './channels/channel';
import type { WebPushSender } from './channels/web-push.sender';

/** Records every send and returns a scripted result. */
class FakeChannel implements NotificationChannelHandler {
  readonly sent: { ctx: ChannelSendContext; message: NotificationMessage }[] = [];
  constructor(
    readonly channel: NotificationChannel,
    private result: ChannelSendResult = { status: 'sent' },
    private configured = true,
  ) {}
  isConfigured(): boolean {
    return this.configured;
  }
  async send(ctx: ChannelSendContext, message: NotificationMessage): Promise<ChannelSendResult> {
    this.sent.push({ ctx, message });
    return this.result;
  }
}

const fakeWebPushSender: WebPushSender = {
  isConfigured: () => true,
  getPublicKey: () => 'FAKE_VAPID_PUBLIC_KEY',
  send: async () => undefined,
};

describe('NotificationsService', () => {
  let dataSource: DataSource;
  let preferences: NotificationPreferencesService;
  let subscriptions: PushSubscriptionsService;
  let deliveries: Repository<NotificationDeliveryEntity>;
  let webPush: FakeChannel;
  let email: FakeChannel;
  let bot: FakeChannel;
  let service: NotificationsService;

  const USER = 'user-1';

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();

    preferences = new NotificationPreferencesService(
      dataSource.getRepository(NotificationSettingsEntity),
      dataSource.getRepository(NotificationCategoryPreferenceEntity),
    );
    subscriptions = new PushSubscriptionsService(
      dataSource.getRepository(PushSubscriptionEntity),
    );
    deliveries = dataSource.getRepository(NotificationDeliveryEntity);

    webPush = new FakeChannel('web_push');
    email = new FakeChannel('email');
    bot = new FakeChannel('bot', { status: 'not_configured' }, false);
    service = new NotificationsService(
      [webPush, email, bot],
      fakeWebPushSender,
      preferences,
      subscriptions,
      deliveries,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Disable quiet hours so the default 22:00–07:00 window can't interfere. */
  async function disableQuietHours(): Promise<void> {
    await preferences.update(USER, {
      quietHours: { enabled: false, start: '22:00', end: '07:00' },
    });
  }

  it('delivers to a category default channel and logs the dispatch', async () => {
    await disableQuietHours();
    // morning_briefing defaults to web_push, cap 1/day.
    const result = await service.notify(USER, {
      category: 'morning_briefing',
      title: 'Good morning',
      body: 'Here is your day.',
    });
    expect(result.outcome).toBe('sent');
    expect(webPush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
    expect(await deliveries.count({ where: { userId: USER, status: 'sent' } })).toBe(1);
  });

  it('skips channels the category is not opted into', async () => {
    await disableQuietHours();
    // Ask for email too, but morning_briefing only opts into web_push.
    const result = await service.notify(USER, {
      category: 'morning_briefing',
      title: 't',
      body: 'b',
      channels: ['web_push', 'email'],
    });
    expect(webPush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
    expect(result.channels).toContainEqual({
      channel: 'email',
      status: 'opted_out',
      detail: 'not opted in for this category',
    });
  });

  it('returns no_channels when the category is fully muted', async () => {
    await disableQuietHours();
    await preferences.update(USER, {
      categories: [{ category: 'morning_briefing', channels: [], maxPerDay: 1 }],
    });
    const result = await service.notify(USER, {
      category: 'morning_briefing',
      title: 't',
      body: 'b',
    });
    expect(result.outcome).toBe('no_channels');
    expect(webPush.sent).toHaveLength(0);
  });

  it('suppresses during quiet hours and reports a retry time', async () => {
    // Quiet hours 00:00–23:59 UTC → always quiet.
    await preferences.update(USER, {
      timezone: 'UTC',
      quietHours: { enabled: true, start: '00:00', end: '23:59' },
    });
    const result = await service.notify(
      USER,
      { category: 'morning_briefing', title: 't', body: 'b' },
      new Date('2026-01-15T09:00:00Z'),
    );
    expect(result.outcome).toBe('suppressed_quiet_hours');
    expect(result.retryAfter).toBe('2026-01-15T23:59:00.000Z');
    expect(webPush.sent).toHaveLength(0);
  });

  it('enforces the per-category frequency cap', async () => {
    await disableQuietHours();
    await preferences.update(USER, {
      categories: [{ category: 'commitment_nudge', channels: ['web_push'], maxPerDay: 2 }],
    });
    const send = () =>
      service.notify(USER, { category: 'commitment_nudge', title: 't', body: 'b' });
    expect((await send()).outcome).toBe('sent');
    expect((await send()).outcome).toBe('sent');
    const third = await send();
    expect(third.outcome).toBe('frequency_capped');
    expect(webPush.sent).toHaveLength(2);
  });

  it('fans out to multiple opted-in channels', async () => {
    await disableQuietHours();
    await preferences.update(USER, {
      categories: [{ category: 'weekly_digest', channels: ['web_push', 'email'], maxPerDay: null }],
    });
    const result = await service.notify(USER, {
      category: 'weekly_digest',
      title: 'Weekly',
      body: 'Digest',
    });
    expect(result.outcome).toBe('sent');
    expect(webPush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('test sends bypass opt-in, quiet hours and caps and log as test', async () => {
    // Quiet hours always on; category not opted into email.
    await preferences.update(USER, {
      quietHours: { enabled: true, start: '00:00', end: '23:59' },
    });
    const result = await service.notify(
      USER,
      {
        category: 'morning_briefing',
        title: 'Test',
        body: 'Ping',
        channels: ['web_push', 'email'],
        bypassGating: true,
      },
      new Date('2026-01-15T09:00:00Z'),
    );
    expect(result.outcome).toBe('sent');
    expect(webPush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    // Logged as `test`, so it does not count against the cap.
    expect(await deliveries.count({ where: { userId: USER, status: 'test' } })).toBe(1);
    expect(await deliveries.count({ where: { userId: USER, status: 'sent' } })).toBe(0);
  });

  it('reports channel configuration status', () => {
    expect(service.channelStatus()).toEqual({ web_push: true, email: true, bot: false });
  });
});
