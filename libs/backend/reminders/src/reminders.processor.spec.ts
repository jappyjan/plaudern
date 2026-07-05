import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ReminderEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import { reminderExtractionPayloadSchema } from '@plaudern/contracts';
import type {
  ReminderExtractionInput,
  ReminderExtractionProvider,
  ReminderExtractionResult,
} from './reminders.provider';
import { ReminderContextService } from './reminder-context';
import { RemindersPersistenceService } from './reminders-persistence.service';
import { RemindersProcessor } from './reminders.processor';

const USER = '00000000-0000-0000-0000-0000000000aa';
// A source timestamp deliberately in the past relative to "now" so any relative
// date resolves against IT, not the wall clock.
const OCCURRED_AT = '2025-03-10T09:00:00Z';

/** Minimal InboxService stand-in backed by the same sqlite repositories. */
function fakeInbox(dataSource: DataSource): InboxService {
  const items = dataSource.getRepository(InboxItemEntity);
  const extractions = dataSource.getRepository(ExtractedPayloadEntity);
  return {
    async setExtractionStatus(id: string, status: string) {
      await extractions.update({ id }, { status: status as ExtractedPayloadEntity['status'] });
    },
    async getItemById(id: string) {
      return items.findOne({ where: { id }, relations: { source: true, extractions: true } });
    },
    async completeExtraction(
      id: string,
      result: { status: 'succeeded' | 'failed'; content?: string; error?: string },
    ) {
      await extractions.update(
        { id },
        {
          status: result.status,
          content: result.content ?? null,
          error: result.error ?? null,
          completedAt: new Date().toISOString(),
        },
      );
    },
  } as unknown as InboxService;
}

/** Programmable LLM provider fake. */
function fakeProvider(
  respond: (input: ReminderExtractionInput) => ReminderExtractionResult,
): ReminderExtractionProvider {
  return {
    id: 'test:reminders',
    extract: async (_userId, input) => respond(input),
  };
}

type RawReminder = {
  title: string;
  dueDate: string;
  confidence?: number | null;
  sourceQuote?: string | null;
  sourceTimestamp?: number | null;
};

function reminder(r: RawReminder) {
  return {
    confidence: null,
    sourceQuote: null,
    sourceTimestamp: null,
    ...r,
  };
}

describe('RemindersProcessor + persistence', () => {
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

  const remindersRepo = () => dataSource.getRepository(ReminderEntity);

  function buildProcessor(provider: ReminderExtractionProvider): RemindersProcessor {
    const context = new ReminderContextService();
    const persistence = new RemindersPersistenceService(remindersRepo());
    return new RemindersProcessor(fakeInbox(dataSource), context, persistence, provider);
  }

  async function createItem(userId = USER): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: OCCURRED_AT,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  async function createExtraction(
    inboxItemId: string,
    kind: ExtractedPayloadEntity['kind'],
    status: ExtractedPayloadEntity['status'],
    createdAt: Date,
    content: string | null = null,
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version: 1,
      provider: 'test',
      status,
      createdAt,
      content,
    });
    return row.id;
  }

  async function seedJob(
    text: string,
    createdAt = new Date('2025-03-10T09:05:00Z'),
  ): Promise<{ inboxItemId: string; extractionId: string }> {
    const inboxItemId = await createItem();
    await createExtraction(inboxItemId, 'transcription', 'succeeded', new Date('2025-03-10T09:00:00Z'), text);
    const extractionId = await createExtraction(inboxItemId, 'reminders', 'queued', createdAt);
    return { inboxItemId, extractionId };
  }

  it('resolves relative dates against the recording time and records the payload', async () => {
    const job = await seedJob('The results should be in by the 14th, and let us talk again next month.');
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [
          reminder({ title: 'results are due', dueDate: 'the 14th', confidence: 0.8, sourceTimestamp: 5 }),
          reminder({ title: 'talk again', dueDate: 'next month' }),
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    const rows = await remindersRepo().find({ order: { dueAt: 'ASC' } });
    expect(rows).toHaveLength(2);
    // "the 14th" from 2025-03-10 → 2025-03-14; "next month" → 2025-04-10.
    expect(rows[0].dueAt.slice(0, 10)).toBe('2025-03-14');
    expect(rows[0].title).toBe('results are due');
    expect(rows[0].confidence).toBe(0.8);
    expect(rows[0].status).toBe('active');
    expect(rows[1].dueAt.slice(0, 10)).toBe('2025-04-10');

    const payload = reminderExtractionPayloadSchema.parse(
      JSON.parse(
        (await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId }))
          .content!,
      ),
    );
    expect(payload.reminderCount).toBe(2);
  });

  it('skips entries whose date is unparseable or in the past relative to the source', async () => {
    const job = await seedJob('mixed dates');
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [
          reminder({ title: 'keep me', dueDate: '2025-09-01' }),
          reminder({ title: 'unparseable', dueDate: 'someday soon' }),
          reminder({ title: 'already past', dueDate: '2020-01-01' }),
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    const rows = await remindersRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('keep me');
  });

  it('collapses in-batch duplicates (same title + due day) and caps at 50', async () => {
    const job = await seedJob('lots of reminders');
    const many = Array.from({ length: 60 }, (_, i) => reminder({ title: `reminder ${i}`, dueDate: '2025-12-01' }));
    // Exact in-batch duplicate (same title + same day) must collapse.
    many.push(reminder({ title: 'reminder 0', dueDate: '2025-12-01' }));
    await buildProcessor(fakeProvider(() => ({ reminders: many, model: 'm' }))).process({
      extractionId: job.extractionId,
      inboxItemId: job.inboxItemId,
    });
    expect(await remindersRepo().count()).toBe(50);
  });

  it('re-run upserts on the same row (repoints provenance) and reaps stale ACTIVE rows', async () => {
    const job = await seedJob('two reminders');
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [
          reminder({ title: 'file taxes', dueDate: '2025-04-15' }),
          reminder({ title: 'renew passport', dueDate: '2025-06-01' }),
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    expect(await remindersRepo().count()).toBe(2);

    // Re-run: only "file taxes" is re-produced; "renew passport" is still active
    // and no longer produced (should be reaped).
    const second = await createExtraction(job.inboxItemId, 'reminders', 'queued', new Date('2025-03-10T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [reminder({ title: 'file taxes', dueDate: '2025-04-15', confidence: 0.9 })],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await remindersRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('file taxes');
    expect(rows[0].confidence).toBe(0.9);
    expect(rows[0].extractionId).toBe(second);
  });

  it('never demotes or reaps a user-owned status (done / dismissed) on re-extraction', async () => {
    const job = await seedJob('two reminders');
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [
          reminder({ title: 'call the dentist', dueDate: '2025-05-01' }),
          reminder({ title: 'submit report', dueDate: '2025-05-02' }),
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // User marks one done and dismisses the other (the PATCH path).
    const done = await remindersRepo().findOneByOrFail({ title: 'call the dentist' });
    done.status = 'done';
    await remindersRepo().save(done);
    const dismissed = await remindersRepo().findOneByOrFail({ title: 'submit report' });
    dismissed.status = 'dismissed';
    await remindersRepo().save(dismissed);

    // Re-run re-produces "call the dentist" as active and OMITS "submit report".
    // Neither user-owned status may be demoted back to active or reaped.
    const second = await createExtraction(job.inboxItemId, 'reminders', 'queued', new Date('2025-03-10T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        reminders: [reminder({ title: 'call the dentist', dueDate: '2025-05-01' })],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await remindersRepo().find();
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.title === 'call the dentist')!;
    expect(a.status).toBe('done');
    // Provenance still repoints to the latest run.
    expect(a.extractionId).toBe(second);
    const b = rows.find((r) => r.title === 'submit report')!;
    expect(b.status).toBe('dismissed');
  });

  it('marks the extraction failed when the provider throws', async () => {
    const job = await seedJob('a reminder');
    await expect(
      buildProcessor(
        fakeProvider(() => {
          throw new Error('provider exploded');
        }),
      ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId }),
    ).rejects.toThrow('provider exploded');
    const row = await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId });
    expect(row.status).toBe('failed');
    expect(await remindersRepo().count()).toBe(0);
  });
});
