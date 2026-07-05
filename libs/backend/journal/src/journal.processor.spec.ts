import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CalendarEventEntity,
  CalendarFeedEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  JournalDocumentEntity,
} from '@plaudern/persistence';
import { JournalProcessor } from './journal.processor';
import type {
  JournalProvider,
  JournalProviderInput,
  JournalProviderResult,
} from './journal.provider';

const USER = '00000000-0000-0000-0000-0000000000aa';

function fakeConfig(overrides: Record<string, string> = {}): ConfigService {
  return { get: (key: string, def?: string) => overrides[key] ?? def } as unknown as ConfigService;
}

function fakeProvider(
  respond: (input: JournalProviderInput) => JournalProviderResult,
): JournalProvider & { calls: JournalProviderInput[] } {
  const calls: JournalProviderInput[] = [];
  return {
    id: 'test:journal',
    enabled: true,
    calls,
    generate: async (input) => {
      calls.push(input);
      return respond(input);
    },
  };
}

describe('JournalProcessor', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  function build(
    provider: JournalProvider,
    config: Record<string, string> = {},
  ): JournalProcessor {
    return new JournalProcessor(
      fakeConfig(config),
      provider,
      dataSource.getRepository(JournalDocumentEntity),
      dataSource.getRepository(InboxItemEntity),
      dataSource.getRepository(CalendarEventEntity),
    );
  }

  async function seedRecording(occurredAt: string, title: string, body: string): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'summary',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      content: JSON.stringify({ title, layout: 'note', markdown: body }),
    });
    return item.id;
  }

  async function seedEvent(startAt: string, endAt: string, title: string): Promise<string> {
    const feed = await dataSource.getRepository(CalendarFeedEntity).save({
      userId: USER,
      name: 'Personal',
      providerType: 'ics',
    });
    const row = await dataSource.getRepository(CalendarEventEntity).save({
      userId: USER,
      feedId: feed.id,
      externalUid: `uid-${Math.random()}`,
      instanceStart: startAt,
      startAt,
      endAt,
      isAllDay: false,
      title,
    });
    return row.id;
  }

  async function queuedDoc(
    periodType: 'day' | 'week' | 'month' | 'year',
    periodKey: string,
    version = 1,
  ): Promise<string> {
    const row = await dataSource.getRepository(JournalDocumentEntity).save({
      userId: USER,
      periodType,
      periodKey,
      version,
      status: 'queued',
    });
    return row.id;
  }

  it('composes a day from recordings and events, oldest first, citing used markers', async () => {
    const morning = await seedRecording('2026-06-14T08:00:00.000Z', 'Standup', 'We planned the sprint.');
    await seedEvent('2026-06-14T12:00:00.000Z', '2026-06-14T13:00:00.000Z', 'Lunch with Ana');
    const evening = await seedRecording('2026-06-14T20:00:00.000Z', 'Reflection', 'Good day overall.');
    const documentId = await queuedDoc('day', '2026-06-14');

    // Cite [1] (morning recording) and [2] (event) but not [3].
    const provider = fakeProvider(() => ({
      markdown: 'Planned the sprint [1], then lunch [2]. array[9] is not a citation.',
      model: 'test-model',
    }));
    await build(provider).process({ documentId, userId: USER, periodType: 'day', periodKey: '2026-06-14' });

    expect(provider.calls).toHaveLength(1);
    const input = provider.calls[0];
    expect(input.periodType).toBe('day');
    // Oldest-first: [1]=morning recording, [2]=noon event, [3]=evening recording.
    expect(input.sources.map((s) => s.marker)).toEqual([1, 2, 3]);
    expect(input.sources.map((s) => s.kind)).toEqual(['item', 'event', 'item']);
    expect(input.previousMarkdown).toBeNull();

    const row = await dataSource.getRepository(JournalDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('succeeded');
    expect(row.sourceItemCount).toBe(3);
    // array[9] is identifier-adjacent → not treated as a citation, and [3] unused.
    expect(row.markdown).toContain('array[9]');
    expect(row.citations!.map((c) => c.marker)).toEqual([1, 2]);
    expect(row.citations![0]).toMatchObject({ kind: 'item', refId: morning });
    expect(row.citations![1]).toMatchObject({ kind: 'event' });
    expect(evening).toBeTruthy();
  });

  it('composes a rollup from the daily entries, citing them back by day key', async () => {
    await dataSource.getRepository(JournalDocumentEntity).save({
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-10',
      version: 1,
      status: 'succeeded',
      markdown: '# 10 June\nStarted a project [1].',
      citations: [],
      sourceItemCount: 1,
    });
    await dataSource.getRepository(JournalDocumentEntity).save({
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-20',
      version: 1,
      status: 'succeeded',
      markdown: '# 20 June\nShipped it [1].',
      citations: [],
      sourceItemCount: 1,
    });
    const documentId = await queuedDoc('month', '2026-06');

    const provider = fakeProvider(() => ({ markdown: 'A productive month [1][2].' }));
    await build(provider).process({
      documentId,
      userId: USER,
      periodType: 'month',
      periodKey: '2026-06',
    });

    const input = provider.calls[0];
    expect(input.sources.map((s) => s.kind)).toEqual(['journal', 'journal']);

    const row = await dataSource.getRepository(JournalDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('succeeded');
    expect(row.citations!.map((c) => c.refId)).toEqual(['2026-06-10', '2026-06-20']);
    expect(row.citations!.every((c) => c.kind === 'journal')).toBe(true);
  });

  it('composes a YEAR hierarchically from the monthly entries (not the raw days)', async () => {
    const docs = dataSource.getRepository(JournalDocumentEntity);
    // A year full of monthly reviews plus a stray daily that must NOT be pulled in.
    for (const m of ['2026-01', '2026-06', '2026-12']) {
      await docs.save({
        userId: USER,
        periodType: 'month',
        periodKey: m,
        version: 1,
        status: 'succeeded',
        markdown: `Month ${m} in review [1].`,
        citations: [],
        sourceItemCount: 3,
      });
    }
    await docs.save({
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-15',
      version: 1,
      status: 'succeeded',
      markdown: 'A single day [1].',
      citations: [],
      sourceItemCount: 1,
    });
    const documentId = await queuedDoc('year', '2026');

    const provider = fakeProvider(() => ({ markdown: 'A big year [1][2][3].' }));
    await build(provider).process({ documentId, userId: USER, periodType: 'year', periodKey: '2026' });

    const input = provider.calls[0];
    // Sources are the three MONTHS, in order — the day is not a direct child of a year.
    expect(input.sources.map((s) => s.kind)).toEqual(['journal', 'journal', 'journal']);
    const row = await docs.findOneByOrFail({ id: documentId });
    expect(row.citations!.map((c) => c.refId)).toEqual(['2026-01', '2026-06', '2026-12']);
  });

  it('prunes old succeeded versions past the retention limit after a success', async () => {
    const docs = dataSource.getRepository(JournalDocumentEntity);
    await seedRecording('2026-06-14T08:00:00.000Z', 'A', 'Something happened.');
    // Three older succeeded versions already on record.
    for (const v of [1, 2, 3]) {
      await docs.save({
        userId: USER,
        periodType: 'day',
        periodKey: '2026-06-14',
        version: v,
        status: 'succeeded',
        markdown: `v${v}`,
        citations: [],
        sourceItemCount: 1,
      });
    }
    const documentId = await queuedDoc('day', '2026-06-14', 4);
    const provider = fakeProvider(() => ({ markdown: 'Newest [1].' }));
    // Retain only the newest 2 succeeded versions.
    await build(provider, { JOURNAL_HISTORY_LIMIT: '2' }).process({
      documentId,
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-14',
    });

    const remaining = await docs.find({
      where: { periodType: 'day', periodKey: '2026-06-14', status: 'succeeded' },
      order: { version: 'DESC' },
    });
    // Newest two kept (v4 current + v3); v1 and v2 reaped.
    expect(remaining.map((r) => r.version)).toEqual([4, 3]);
  });

  it('passes the previous entry so composition updates rather than rewrites', async () => {
    await seedRecording('2026-06-14T08:00:00.000Z', 'A', 'Something happened.');
    await dataSource.getRepository(JournalDocumentEntity).save({
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-14',
      version: 1,
      status: 'succeeded',
      markdown: 'Earlier draft.',
      citations: [],
      sourceItemCount: 1,
    });
    const documentId = await queuedDoc('day', '2026-06-14', 2);

    const provider = fakeProvider(() => ({ markdown: 'Newer draft [1].' }));
    await build(provider).process({ documentId, userId: USER, periodType: 'day', periodKey: '2026-06-14' });
    expect(provider.calls[0].previousMarkdown).toBe('Earlier draft.');
  });

  it('marks the version failed when there is nothing to compose', async () => {
    const documentId = await queuedDoc('day', '2026-06-14');
    const provider = fakeProvider(() => ({ markdown: 'unused' }));
    await expect(
      build(provider).process({ documentId, userId: USER, periodType: 'day', periodKey: '2026-06-14' }),
    ).rejects.toThrow(/no signals/);
    expect(provider.calls).toHaveLength(0);
    const row = await dataSource.getRepository(JournalDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('failed');
  });
});
