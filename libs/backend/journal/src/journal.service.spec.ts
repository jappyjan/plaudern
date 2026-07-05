import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CalendarEventEntity,
  InboxItemEntity,
  JournalDocumentEntity,
  RecordingMergeEntity,
} from '@plaudern/persistence';
import type { AiConfigService } from '@plaudern/ai-config';
import { JournalService } from './journal.service';
import type { JournalProvider } from './journal.provider';
import type { JournalJob, JournalQueue } from './journal.job';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';

function fakeProvider(): JournalProvider {
  return {
    id: 'test:journal',
    generate: async () => ({ markdown: 'stub', model: 'test-model' }),
  };
}

function fakeAiConfig(enabled = true): AiConfigService {
  return {
    isEnabled: async () => enabled,
    resolve: async () => null,
    invalidate() {},
  } as unknown as AiConfigService;
}

describe('JournalService', () => {
  let dataSource: DataSource;
  let enqueued: JournalJob[];

  function build(enabled = true, provider: JournalProvider = fakeProvider()): JournalService {
    const queue: JournalQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
      },
    };
    return new JournalService(
      fakeAiConfig(enabled),
      provider,
      queue,
      dataSource.getRepository(JournalDocumentEntity),
      dataSource.getRepository(InboxItemEntity),
      dataSource.getRepository(CalendarEventEntity),
    );
  }

  beforeEach(async () => {
    enqueued = [];
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

  async function seedItem(occurredAt: string, user = USER): Promise<string> {
    const row = await dataSource.getRepository(InboxItemEntity).save({
      userId: user,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return row.id;
  }

  async function seedSucceededDaily(dayKey: string, user = USER, version = 1): Promise<void> {
    await dataSource.getRepository(JournalDocumentEntity).save({
      userId: user,
      periodType: 'day',
      periodKey: dayKey,
      version,
      status: 'succeeded',
      markdown: `A day happened [1].`,
      citations: [],
      sourceItemCount: 1,
    });
  }

  it('does not enqueue while disabled', async () => {
    const service = build(false);
    expect(await service.enqueueGeneration(USER, 'day', '2026-06-14')).toBeNull();
    expect(enqueued).toHaveLength(0);
    const rows = await dataSource.getRepository(JournalDocumentEntity).count();
    expect(rows).toBe(0);
  });

  it('enqueues a queued v1 and coalesces a second enqueue', async () => {
    const service = build();
    const first = await service.enqueueGeneration(USER, 'day', '2026-06-14');
    expect(first).toBeTruthy();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ periodType: 'day', periodKey: '2026-06-14' });

    // A queued row already exists — coalesce onto it, no second row/job.
    const second = await service.enqueueGeneration(USER, 'day', '2026-06-14');
    expect(second).toBe(first);
    expect(enqueued).toHaveLength(1);
    expect(await dataSource.getRepository(JournalDocumentEntity).count()).toBe(1);
  });

  it('coalesces onto an in-flight (processing) generation — no duplicate job', async () => {
    // The straddle a hourly sweep hits: a version is mid-flight (processing),
    // there is no queued row, and latestSucceeded is stale. Must NOT spawn a
    // second concurrent generation for the same period.
    const docs = dataSource.getRepository(JournalDocumentEntity);
    const processing = await docs.save({
      userId: USER,
      periodType: 'day',
      periodKey: '2026-06-14',
      version: 1,
      status: 'processing',
    });
    const service = build();
    const result = await service.enqueueGeneration(USER, 'day', '2026-06-14');
    expect(result).toBe(processing.id);
    expect(enqueued).toHaveLength(0);
    expect(await docs.count()).toBe(1);
  });

  it('increments the version past the latest succeeded entry', async () => {
    await seedSucceededDaily('2026-06-14');
    const service = build();
    const id = await service.enqueueGeneration(USER, 'day', '2026-06-14');
    const row = await dataSource
      .getRepository(JournalDocumentEntity)
      .findOneByOrFail({ id: id! });
    expect(row.version).toBe(2);
    expect(row.status).toBe('queued');
  });

  it('reads the current entry and reports enabled/missing states', async () => {
    const service = build();
    const missing = await service.getJournal(USER, 'day', '2026-06-14');
    expect(missing).toMatchObject({ status: null, version: null, markdown: null, enabled: true });

    await seedSucceededDaily('2026-06-14');
    const present = await service.getJournal(USER, 'day', '2026-06-14');
    expect(present).toMatchObject({ version: 1, sourceItemCount: 1 });
    expect(present.markdown).toContain('A day happened');
  });

  it('lists composed periods newest first with a preview, one per key', async () => {
    await seedSucceededDaily('2026-06-13');
    await seedSucceededDaily('2026-06-14', USER, 1);
    await seedSucceededDaily('2026-06-14', USER, 2); // higher version wins
    const service = build();
    const list = await service.listPeriods(USER, 'day');
    expect(list.periods.map((p) => p.periodKey)).toEqual(['2026-06-14', '2026-06-13']);
    expect(list.periods[0].version).toBe(2);
    expect(list.periods[0].preview).toBe('A day happened.');
  });

  it('flags days with signals that have no entry, and clears once composed', async () => {
    await seedItem('2026-06-14T08:00:00.000Z');
    await seedItem('2026-06-14T20:00:00.000Z'); // same day
    await seedItem('2026-06-13T09:00:00.000Z');
    await seedItem('2026-06-13T09:00:00.000Z', OTHER); // other user's day

    const service = build();
    const before = await service.daysNeedingComposition();
    expect(before).toEqual(
      expect.arrayContaining([
        { userId: USER, periodType: 'day', periodKey: '2026-06-14' },
        { userId: USER, periodType: 'day', periodKey: '2026-06-13' },
        { userId: OTHER, periodType: 'day', periodKey: '2026-06-13' },
      ]),
    );
    expect(before).toHaveLength(3);

    // Composing 06-14 (createdAt = now, after the items' ingestedAt) clears it.
    await seedSucceededDaily('2026-06-14');
    const after = await service.daysNeedingComposition();
    expect(after.find((t) => t.userId === USER && t.periodKey === '2026-06-14')).toBeUndefined();
    expect(after).toHaveLength(2);
  });

  it('excludes merged-away recordings from day candidates', async () => {
    const source = await seedItem('2026-06-20T08:00:00.000Z');
    const merged = await seedItem('2026-06-21T08:00:00.000Z');
    await dataSource.getRepository(RecordingMergeEntity).save({
      userId: USER,
      mergedItemId: merged,
      sourceItemId: source,
      position: 0,
      sourceDurationSeconds: 1,
    });
    const service = build();
    const days = (await service.daysNeedingComposition()).map((t) => t.periodKey);
    expect(days).toContain('2026-06-21'); // merged item still counts
    expect(days).not.toContain('2026-06-20'); // its hidden source does not
  });

  it('flags ended rollups from succeeded dailies, not the current period', async () => {
    // Two days in May (ended) and one in the current-ish future month.
    await seedSucceededDaily('2026-05-10');
    await seedSucceededDaily('2026-05-20');
    await seedSucceededDaily('2026-08-05');

    const service = build();
    const now = new Date('2026-08-10T00:00:00Z'); // May ended; August not yet
    const rollups = await service.rollupsNeedingComposition(now);
    const keys = rollups.map((r) => `${r.periodType}:${r.periodKey}`);
    expect(keys).toContain('month:2026-05');
    expect(keys).toContain('week:2026-W19'); // week of 2026-05-04..10
    // 2026 the year has NOT ended at `now`, so no year rollup yet.
    expect(keys).not.toContain('year:2026');
    // August is the current month → not ended → excluded.
    expect(keys).not.toContain('month:2026-08');
  });

  it('regenerate gates on config, key validity and available sources', async () => {
    await expect(build(false).regenerate(USER, 'day', '2026-06-14')).rejects.toThrow(
      BadRequestException,
    );
    await expect(build().regenerate(USER, 'day', 'garbage')).rejects.toThrow(BadRequestException);
    // Valid key but no signal that day.
    await expect(build().regenerate(USER, 'day', '2026-06-14')).rejects.toThrow(/no signals/);

    // With a signal it enqueues.
    await seedItem('2026-06-14T08:00:00.000Z');
    const id = await build().regenerate(USER, 'day', '2026-06-14');
    expect(id).toBeTruthy();
  });
});
