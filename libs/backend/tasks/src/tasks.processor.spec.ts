import { DataSource } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  TaskCitationEntity,
  TaskEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { SelfProfileService, type InboxService } from '@plaudern/inbox';
import type { EmbeddingProvider } from '@plaudern/embeddings';
import { taskExtractionPayloadSchema } from '@plaudern/contracts';
import type {
  TaskExtractionInput,
  TaskExtractionProvider,
  TaskExtractionResult,
} from './tasks.provider';
import { TasksRegistryService } from './tasks-registry.service';
import { TaskContextService } from './task-context';
import { TasksProcessor } from './tasks.processor';

const USER = '00000000-0000-0000-0000-0000000000aa';

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
  respond: (input: TaskExtractionInput) => TaskExtractionResult,
): TaskExtractionProvider {
  return {
    id: 'test:tasks',
    enabled: true,
    extract: async (input) => respond(input),
  };
}

/**
 * Deterministic embedding fake: titles that share a keyword bucket get the SAME
 * unit vector (cosine 1.0 → a semantic match); different buckets are orthogonal
 * (cosine 0 → no match). Lets us test semantic dedupe without a real model.
 */
const BUCKETS = ['dentist', 'passport', 'anna'];
function bucketVector(title: string): number[] {
  const lower = title.toLowerCase();
  const vec = BUCKETS.map((b) => (lower.includes(b) ? 1 : 0));
  return vec.some((v) => v === 1) ? vec : [0, 0, 0.0001 * (title.length % 7) + 0.5];
}
function fakeEmbeddings(enabled: boolean): EmbeddingProvider {
  return {
    id: 'test:embed',
    enabled,
    dimensions: 3,
    embed: async (texts: string[]) => ({
      vectors: texts.map(bucketVector),
      model: 'test:embed',
      dimensions: 3,
    }),
  };
}

const fakeConfig = { get: () => '' } as unknown as ConfigService;

describe('TasksProcessor + semantic dedupe', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    // Every seeded item belongs to USER; give them an account owner so the task
    // context resolves to `ready` (extraction is gated on a self profile).
    await dataSource.getRepository(VoiceProfileEntity).save({ userId: USER, name: null, isSelf: true });
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  function buildProcessor(
    provider: TaskExtractionProvider,
    embeddingsEnabled = true,
  ): { processor: TasksProcessor; registry: TasksRegistryService } {
    const selfProfile = new SelfProfileService(dataSource.getRepository(VoiceProfileEntity));
    const registry = new TasksRegistryService(
      dataSource.getRepository(TaskEntity),
      dataSource.getRepository(TaskCitationEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      fakeEmbeddings(embeddingsEnabled),
      fakeConfig,
      selfProfile,
    );
    const context = new TaskContextService(
      dataSource.getRepository(SpeakerOccurrenceEntity),
      selfProfile,
    );
    const processor = new TasksProcessor(fakeInbox(dataSource), registry, provider, context);
    return { processor, registry };
  }

  async function createItem(userId = USER): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
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

  async function seedJob(text: string, userId = USER): Promise<{ inboxItemId: string; extractionId: string }> {
    const inboxItemId = await createItem(userId);
    await createExtraction(inboxItemId, 'transcription', 'succeeded', new Date('2026-07-01T10:00:00Z'), text);
    const extractionId = await createExtraction(inboxItemId, 'tasks', 'queued', new Date('2026-07-01T10:05:00Z'));
    return { inboxItemId, extractionId };
  }

  const tasksRepo = () => dataSource.getRepository(TaskEntity);
  const citationsRepo = () => dataSource.getRepository(TaskCitationEntity);

  it('collapses two mentions of the same errand across items into ONE task with two citations', async () => {
    // Item 1: "book the dentist"
    const a = await seedJob('I really need to book the dentist this week.');
    await buildProcessor(
      fakeProvider(() => ({
        tasks: [{ title: 'Book the dentist', dueDate: null, quote: 'I really need to book the dentist this week.' }],
        model: 'm',
      })),
    ).processor.process({ extractionId: a.extractionId, inboxItemId: a.inboxItemId });

    // Item 2: a DIFFERENT phrasing of the same dentist errand — semantic match.
    const b = await seedJob('Remember to schedule that dentist appointment.');
    await buildProcessor(
      fakeProvider(() => ({
        tasks: [{ title: 'Schedule dentist appointment', dueDate: null, quote: 'Remember to schedule that dentist appointment.' }],
        model: 'm',
      })),
    ).processor.process({ extractionId: b.extractionId, inboxItemId: b.inboxItemId });

    expect(await tasksRepo().count()).toBe(1);
    expect(await citationsRepo().count()).toBe(2);
    const payloadB = taskExtractionPayloadSchema.parse(
      JSON.parse((await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: b.extractionId })).content!),
    );
    expect(payloadB.taskCount).toBe(1);
  });

  it('creates separate tasks for unrelated intentions', async () => {
    const job = await seedJob('I need to book the dentist and also renew my passport.');
    await buildProcessor(
      fakeProvider(() => ({
        tasks: [
          { title: 'Book the dentist', dueDate: null, quote: 'I need to book the dentist' },
          { title: 'Renew passport', dueDate: '2026-08-01', quote: 'renew my passport' },
        ],
        model: 'm',
      })),
    ).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    expect(await tasksRepo().count()).toBe(2);
    expect(await citationsRepo().count()).toBe(2);
  });

  it('is idempotent on backfill: re-running the SAME extraction never duplicates citations', async () => {
    const job = await seedJob('I need to book the dentist.');
    const provider = fakeProvider(() => ({
      tasks: [{ title: 'Book the dentist', dueDate: null, quote: 'I need to book the dentist.' }],
      model: 'm',
    }));
    await buildProcessor(provider).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    await buildProcessor(provider).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    expect(await tasksRepo().count()).toBe(1);
    expect(await citationsRepo().count()).toBe(1);
  });

  it('falls back to normalized-text match when embeddings are not configured', async () => {
    const a = await seedJob('Book the dentist.');
    await buildProcessor(
      fakeProvider(() => ({ tasks: [{ title: 'Book the dentist', dueDate: null, quote: 'Book the dentist.' }], model: 'm' })),
      false,
    ).processor.process({ extractionId: a.extractionId, inboxItemId: a.inboxItemId });

    // Same errand, different case/punctuation → normalized-text dedupe collapses it.
    const b = await seedJob('book the dentist');
    await buildProcessor(
      fakeProvider(() => ({ tasks: [{ title: 'book the dentist', dueDate: null, quote: 'book the dentist' }], model: 'm' })),
      false,
    ).processor.process({ extractionId: b.extractionId, inboxItemId: b.inboxItemId });

    // A genuinely different title stays separate.
    const c = await seedJob('Renew my passport.');
    await buildProcessor(
      fakeProvider(() => ({ tasks: [{ title: 'Renew passport', dueDate: null, quote: 'Renew my passport.' }], model: 'm' })),
      false,
    ).processor.process({ extractionId: c.extractionId, inboxItemId: c.inboxItemId });

    const rows = await tasksRepo().find();
    expect(rows).toHaveLength(2);
    // The text-deduped task carries no embedding.
    const dentist = rows.find((r) => r.normalizedTitle === 'book the dentist');
    expect(dentist?.embedding).toBeNull();
  });

  it('recovers from a concurrent-insert unique violation by citing the winner', async () => {
    // Simulate losing the race: another worker inserts the same open task
    // between our exact-match read and our insert. We force the read to miss
    // (findOne -> null once) while the winner row actually exists, so the
    // insert trips the partial unique index (userId, normalizedTitle, open)
    // and the recovery path must re-read and cite the winner.
    const winner = await tasksRepo().save(
      tasksRepo().create({
        userId: USER,
        title: 'Book the dentist',
        normalizedTitle: 'book the dentist',
        status: 'open',
        dueDate: null,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      }),
    );
    const repo = tasksRepo();
    const findOneSpy = jest.spyOn(repo, 'findOne').mockResolvedValueOnce(null);

    const job = await seedJob('I need to book the dentist.');
    await buildProcessor(
      fakeProvider(() => ({
        tasks: [{ title: 'Book the dentist', dueDate: null, quote: 'I need to book the dentist.' }],
        model: 'm',
      })),
      false,
    ).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    findOneSpy.mockRestore();

    // No duplicate row; the citation landed on the pre-existing winner.
    expect(await tasksRepo().count()).toBe(1);
    const citations = await citationsRepo().find();
    expect(citations).toHaveLength(1);
    expect(citations[0].taskId).toBe(winner.id);
  });

  it('enforces one open task per (user, normalized title) at the schema level', async () => {
    await tasksRepo().save(
      tasksRepo().create({
        userId: USER,
        title: 'Book the dentist',
        normalizedTitle: 'book the dentist',
        status: 'open',
        dueDate: null,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      }),
    );
    // A duplicate OPEN row is rejected by the partial unique index...
    await expect(
      tasksRepo().insert({
        userId: USER,
        title: 'book the dentist',
        normalizedTitle: 'book the dentist',
        status: 'open',
        dueDate: null,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      }),
    ).rejects.toThrow(/UNIQUE|unique/);
    // ...but a completed row with the same title is fine (partial index).
    await expect(
      tasksRepo().insert({
        userId: USER,
        title: 'book the dentist',
        normalizedTitle: 'book the dentist',
        status: 'completed',
        dueDate: null,
        embedding: null,
        embeddingModel: null,
        embeddingDimensions: null,
      }),
    ).resolves.toBeDefined();
  });

  it('hides superseded open tasks (zero live citations) from list() but keeps them as rows', async () => {
    // First run cites dentist + passport.
    const job = await seedJob('Book the dentist and renew my passport.');
    await buildProcessor(
      fakeProvider(() => ({
        tasks: [
          { title: 'Book the dentist', dueDate: null, quote: null },
          { title: 'Renew passport', dueDate: null, quote: null },
        ],
        model: 'm',
      })),
      false,
    ).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // A re-run of the same item finds only the dentist — the passport task's
    // citations are superseded (latest succeeded extraction wins).
    const secondExtractionId = await createExtraction(
      job.inboxItemId,
      'tasks',
      'queued',
      new Date('2026-07-01T11:00:00Z'),
    );
    const { processor, registry } = buildProcessor(
      fakeProvider(() => ({
        tasks: [{ title: 'Book the dentist', dueDate: null, quote: null }],
        model: 'm',
      })),
      false,
    );
    await processor.process({ extractionId: secondExtractionId, inboxItemId: job.inboxItemId });

    const open = await registry.list(USER, 'open');
    expect(open.map((t) => t.title)).toEqual(['Book the dentist']);
    // The ghost row survives as a future dedupe target — only the list hides it.
    expect(await tasksRepo().count()).toBe(2);
  });

  it('rejects reopening a task when a fresh open task with the same title exists', async () => {
    const make = (status: 'open' | 'dismissed') =>
      tasksRepo().save(
        tasksRepo().create({
          userId: USER,
          title: 'Book the dentist',
          normalizedTitle: 'book the dentist',
          status,
          dueDate: null,
          embedding: null,
          embeddingModel: null,
          embeddingDimensions: null,
        }),
      );
    const dismissed = await make('dismissed');
    await make('open');
    const { registry } = buildProcessor(fakeProvider(() => ({ tasks: [] })), false);
    await expect(registry.updateStatus(USER, dismissed.id, 'open')).rejects.toThrow(
      /already exists/,
    );
  });

  it('caps a runaway extraction at 50 ingested tasks', async () => {
    const job = await seedJob('So many things to do.');
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `Unique task number ${i}`,
      dueDate: null,
      quote: null,
    }));
    await buildProcessor(fakeProvider(() => ({ tasks: many, model: 'm' })), false)
      .processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    expect(await tasksRepo().count()).toBe(50);
    expect(await citationsRepo().count()).toBe(50);
  });

  it('exposes the item read model, deep-links the quote, and updates status', async () => {
    const inboxItemId = await createItem();
    await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'transcription',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
      content: 'I need to book the dentist.',
      segments: [{ start: 3.5, end: 6.0, text: 'I need to book the dentist.' }],
    });
    const extractionId = await createExtraction(inboxItemId, 'tasks', 'queued', new Date('2026-07-01T10:05:00Z'));

    const { processor, registry } = buildProcessor(
      fakeProvider(() => ({
        tasks: [{ title: 'Book the dentist', dueDate: '2026-07-05', quote: 'I need to book the dentist.' }],
        model: 'm',
      })),
    );
    await processor.process({ extractionId, inboxItemId });

    const item = await dataSource
      .getRepository(InboxItemEntity)
      .findOneOrFail({ where: { id: inboxItemId }, relations: { extractions: true } });
    const read = await registry.getItemTasks(item);
    expect(read.status).toBe('succeeded');
    expect(read.tasks).toHaveLength(1);
    expect(read.tasks[0]).toMatchObject({
      title: 'Book the dentist',
      status: 'open',
      dueDate: '2026-07-05',
      startSeconds: 3.5,
      endSeconds: 6.0,
    });

    // List + status mutation.
    const openBefore = await registry.list(USER, 'open');
    expect(openBefore).toHaveLength(1);
    expect(openBefore[0].citationCount).toBe(1);
    const done = await registry.updateStatus(USER, read.tasks[0].taskId, 'completed');
    expect(done.status).toBe('completed');
    expect(await registry.list(USER, 'open')).toHaveLength(0);
    expect(await registry.list(USER, 'completed')).toHaveLength(1);
  });

  it('marks the extraction failed when the provider throws', async () => {
    const job = await seedJob('I need to book the dentist.');
    const provider = fakeProvider(() => {
      throw new Error('provider exploded');
    });
    await expect(
      buildProcessor(provider).processor.process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId }),
    ).rejects.toThrow('provider exploded');
    const row = await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId });
    expect(row.status).toBe('failed');
    expect(await tasksRepo().count()).toBe(0);
  });
});
