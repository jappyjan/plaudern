import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  QuestionEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import { questionExtractionPayloadSchema } from '@plaudern/contracts';
import type {
  QuestionExtractionInput,
  QuestionExtractionProvider,
  QuestionExtractionResult,
} from './questions.provider';
import { QuestionContextService } from './question-context';
import { QuestionsPersistenceService } from './questions-persistence.service';
import { QuestionsProcessor } from './questions.processor';

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
  respond: (input: QuestionExtractionInput) => QuestionExtractionResult,
): QuestionExtractionProvider {
  return {
    id: 'test:questions',
    extract: async (_userId, input) => respond(input),
  };
}

describe('QuestionsProcessor + persistence', () => {
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

  const questionsRepo = () => dataSource.getRepository(QuestionEntity);

  function buildProcessor(provider: QuestionExtractionProvider): QuestionsProcessor {
    const context = new QuestionContextService(dataSource.getRepository(SpeakerOccurrenceEntity));
    const persistence = new QuestionsPersistenceService(
      questionsRepo(),
      dataSource.getRepository(EntityRegistryEntity),
    );
    return new QuestionsProcessor(fakeInbox(dataSource), context, persistence, provider);
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

  async function seedJob(
    text: string,
    createdAt = new Date('2026-07-01T10:05:00Z'),
  ): Promise<{ inboxItemId: string; extractionId: string }> {
    const inboxItemId = await createItem();
    await createExtraction(inboxItemId, 'transcription', 'succeeded', new Date('2026-07-01T10:00:00Z'), text);
    const extractionId = await createExtraction(inboxItemId, 'questions', 'queued', createdAt);
    return { inboxItemId, extractionId };
  }

  it('persists both directions and maps answered → status', async () => {
    const job = await seedJob('Did you hear back from the landlord? When is the report due?');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          {
            direction: 'asked_by_me',
            counterparty: 'Anna',
            question: 'did the landlord reply',
            answered: false,
            sourceQuote: 'Did you hear back from the landlord?',
            sourceTimestamp: 2,
          },
          {
            direction: 'asked_of_me',
            counterparty: 'Tom',
            question: 'when is the report due',
            answered: true,
            sourceQuote: 'When is the report due?',
            sourceTimestamp: 5,
          },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    const rows = await questionsRepo().find();
    expect(rows).toHaveLength(2);
    const asked = rows.find((r) => r.direction === 'asked_by_me')!;
    expect(asked.status).toBe('open');
    expect(asked.counterpartyName).toBe('Anna');
    const of = rows.find((r) => r.direction === 'asked_of_me')!;
    expect(of.status).toBe('answered');

    const payload = questionExtractionPayloadSchema.parse(
      JSON.parse(
        (await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId }))
          .content!,
      ),
    );
    expect(payload.questionCount).toBe(2);
  });

  it('resolves sourceTimestamp structurally by locating the sourceQuote in transcript segments (JJ-71)', async () => {
    // The model is NOT asked for a timestamp — it supplies only a sourceQuote,
    // which the processor maps back to the timed transcription segment it came
    // from (the same quote→timestamp resolution memory-chat citations use).
    const inboxItemId = await createItem();
    await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'transcription',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
      content: 'Did you hear back from the landlord? When is the report due?',
      segments: [
        { start: 0, end: 3, text: 'Did you hear back from the landlord?' },
        { start: 12.5, end: 15, text: 'When is the report due?' },
      ],
    });
    const extractionId = await createExtraction(
      inboxItemId,
      'questions',
      'queued',
      new Date('2026-07-01T10:05:00Z'),
    );

    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          {
            direction: 'asked_by_me',
            counterparty: '',
            question: 'did the landlord reply',
            answered: false,
            sourceQuote: 'Did you hear back from the landlord?',
            // Even a bogus model-supplied timestamp is ignored — resolution is structural.
            sourceTimestamp: 999,
          },
          {
            direction: 'asked_of_me',
            counterparty: '',
            question: 'when is the report due',
            answered: false,
            sourceQuote: 'When is the report due?',
            sourceTimestamp: null,
          },
          {
            direction: 'asked_by_me',
            counterparty: '',
            question: 'a question never spoken aloud',
            answered: false,
            // Quote absent from the transcript → no timestamp resolves.
            sourceQuote: 'this phrase is nowhere in the transcript',
            sourceTimestamp: null,
          },
        ],
        model: 'm',
      })),
    ).process({ extractionId, inboxItemId });

    const rows = await questionsRepo().find();
    const first = rows.find((r) => r.normalizedQuestion === 'did the landlord reply')!;
    expect(first.sourceTimestamp).toBe(0);
    const second = rows.find((r) => r.normalizedQuestion === 'when is the report due')!;
    expect(second.sourceTimestamp).toBe(12.5);
    const unlocatable = rows.find((r) => r.normalizedQuestion === 'a question never spoken aloud')!;
    expect(unlocatable.sourceTimestamp).toBeNull();
  });

  it('collapses duplicate questions within a batch and caps at 50', async () => {
    const job = await seedJob('Lots of questions.');
    const many = Array.from({ length: 60 }, (_, i) => ({
      direction: 'asked_by_me' as const,
      counterparty: '',
      question: `unique question number ${i}`,
      answered: false,
      sourceQuote: null,
      sourceTimestamp: null,
    }));
    // Plus an exact in-batch duplicate that must be collapsed.
    many.push({ ...many[0] });
    await buildProcessor(fakeProvider(() => ({ questions: many, model: 'm' }))).process({
      extractionId: job.extractionId,
      inboxItemId: job.inboxItemId,
    });
    expect(await questionsRepo().count()).toBe(50);
  });

  it('re-run upserts on the same row, promotes open → answered, and reaps stale OPEN rows', async () => {
    const job = await seedJob('two questions');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'q one', answered: false, sourceQuote: null, sourceTimestamp: null },
          { direction: 'asked_by_me', counterparty: '', question: 'q two', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    expect(await questionsRepo().count()).toBe(2);

    // Re-run: q one now answered (model-driven promotion), q two still open
    // and no longer produced (should be reaped).
    const second = await createExtraction(job.inboxItemId, 'questions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'q one', answered: true, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await questionsRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].question).toBe('q one');
    expect(rows[0].status).toBe('answered');
    expect(rows[0].extractionId).toBe(second);
  });

  it('never demotes a user-answered question back to open on re-extraction', async () => {
    const job = await seedJob('one question');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'q one', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // User marks it answered (the PATCH path).
    const row = await questionsRepo().findOneByOrFail({ inboxItemId: job.inboxItemId });
    row.status = 'answered';
    await questionsRepo().save(row);

    // Re-run re-produces the SAME normalizedQuestion with answered=false — the
    // user's resolution must survive (answered is durable once set).
    const second = await createExtraction(job.inboxItemId, 'questions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'q one', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await questionsRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('answered');
    // Provenance still repoints to the latest run.
    expect(rows[0].extractionId).toBe(second);
  });

  it('never reaps a user-answered question when a re-run paraphrases it', async () => {
    const job = await seedJob('one question');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'did the landlord reply', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // User marks it answered.
    const row = await questionsRepo().findOneByOrFail({ inboxItemId: job.inboxItemId });
    row.status = 'answered';
    await questionsRepo().save(row);

    // Re-run paraphrases the question (different normalizedQuestion). The old
    // answered row is on an older extractionId but must NOT be reaped; the
    // paraphrase lands as a fresh open duplicate (documented, mirrors the
    // tasks duplicate-open behavior).
    const second = await createExtraction(job.inboxItemId, 'questions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'has the landlord gotten back to us', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await questionsRepo().find();
    expect(rows).toHaveLength(2);
    const answered = rows.find((r) => r.normalizedQuestion === 'did the landlord reply')!;
    expect(answered.status).toBe('answered');
    const fresh = rows.find((r) => r.normalizedQuestion === 'has the landlord gotten back to us')!;
    expect(fresh.status).toBe('open');
    expect(fresh.extractionId).toBe(second);
  });

  it('never resurrects a user-dropped question on re-extraction', async () => {
    const job = await seedJob('one question');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: '', question: 'q one', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // User drops it.
    const row = await questionsRepo().findOneByOrFail({ inboxItemId: job.inboxItemId });
    row.status = 'dropped';
    await questionsRepo().save(row);

    // Re-run that would re-produce it as open must NOT flip it back to open, and
    // a run that omits it must NOT reap it (dropped is the user's decision).
    const second = await createExtraction(job.inboxItemId, 'questions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(fakeProvider(() => ({ questions: [], model: 'm' }))).process({
      extractionId: second,
      inboxItemId: job.inboxItemId,
    });

    const rows = await questionsRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dropped');
  });

  it('links a counterparty to a matching person registry entity', async () => {
    await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName: 'Anna',
      normalizedName: 'anna',
      aliases: [],
    });
    const job = await seedJob('a question for anna');
    await buildProcessor(
      fakeProvider(() => ({
        questions: [
          { direction: 'asked_by_me', counterparty: 'Anna', question: 'q', answered: false, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    const row = await questionsRepo().findOneByOrFail({ inboxItemId: job.inboxItemId });
    expect(row.counterpartyEntityId).not.toBeNull();
  });

  it('marks the extraction failed when the provider throws', async () => {
    const job = await seedJob('a question');
    await expect(
      buildProcessor(
        fakeProvider(() => {
          throw new Error('provider exploded');
        }),
      ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId }),
    ).rejects.toThrow('provider exploded');
    const row = await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId });
    expect(row.status).toBe('failed');
    expect(await questionsRepo().count()).toBe(0);
  });
});
