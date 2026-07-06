import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  DecisionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import { decisionExtractionPayloadSchema } from '@plaudern/contracts';
import type {
  DecisionExtractionInput,
  DecisionExtractionProvider,
  DecisionExtractionResult,
} from './decisions.provider';
import { DecisionContextService } from './decision-context';
import { DecisionsPersistenceService } from './decisions-persistence.service';
import { DecisionsProcessor } from './decisions.processor';

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
  respond: (input: DecisionExtractionInput) => DecisionExtractionResult,
): DecisionExtractionProvider {
  return {
    id: 'test:decisions',
    extract: async (_userId, input) => respond(input),
  };
}

describe('DecisionsProcessor + persistence', () => {
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

  const decisionsRepo = () => dataSource.getRepository(DecisionEntity);

  function buildProcessor(provider: DecisionExtractionProvider): DecisionsProcessor {
    const context = new DecisionContextService(dataSource.getRepository(SpeakerOccurrenceEntity));
    const persistence = new DecisionsPersistenceService(
      decisionsRepo(),
      dataSource.getRepository(EntityRegistryEntity),
    );
    return new DecisionsProcessor(fakeInbox(dataSource), context, persistence, provider);
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
    const extractionId = await createExtraction(inboxItemId, 'decisions', 'queued', createdAt);
    return { inboxItemId, extractionId };
  }

  it('persists decisions with context, participants, and confidence, and records the payload', async () => {
    const job = await seedJob('We decided to go with the cheaper vendor because the budget is tight.');
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          {
            decision: 'go with the cheaper vendor',
            context: 'the budget is tight',
            participants: 'Anna and me',
            confidence: 0.9,
            sourceQuote: 'We decided to go with the cheaper vendor',
            sourceTimestamp: 3,
          },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    const rows = await decisionsRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('go with the cheaper vendor');
    expect(rows[0].context).toBe('the budget is tight');
    expect(rows[0].participants).toBe('Anna and me');
    expect(rows[0].confidence).toBe(0.9);
    expect(rows[0].status).toBe('active');

    const payload = decisionExtractionPayloadSchema.parse(
      JSON.parse(
        (await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId }))
          .content!,
      ),
    );
    expect(payload.decisionCount).toBe(1);
  });

  it('collapses duplicate decisions within a batch and caps at 50', async () => {
    const job = await seedJob('Lots of decisions.');
    const many = Array.from({ length: 60 }, (_, i) => ({
      decision: `unique decision number ${i}`,
      context: null,
      participants: '',
      confidence: null,
      sourceQuote: null,
      sourceTimestamp: null,
    }));
    // Plus an exact in-batch duplicate that must be collapsed.
    many.push({ ...many[0] });
    await buildProcessor(fakeProvider(() => ({ decisions: many, model: 'm' }))).process({
      extractionId: job.extractionId,
      inboxItemId: job.inboxItemId,
    });
    expect(await decisionsRepo().count()).toBe(50);
  });

  it('re-run upserts on the same row (repoints provenance) and reaps stale ACTIVE rows', async () => {
    const job = await seedJob('two decisions');
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          { decision: 'switch banks', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
          { decision: 'postpone the trip', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    expect(await decisionsRepo().count()).toBe(2);

    // Re-run: only "switch banks" is re-produced; "postpone the trip" is still
    // active and no longer produced (should be reaped).
    const second = await createExtraction(job.inboxItemId, 'decisions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          { decision: 'switch banks', context: 'better rates', participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await decisionsRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('switch banks');
    expect(rows[0].context).toBe('better rates');
    expect(rows[0].extractionId).toBe(second);
  });

  it('never demotes or reaps a user-owned status (revisited / superseded) on re-extraction', async () => {
    const job = await seedJob('two decisions');
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          { decision: 'use vendor A', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
          { decision: 'ship on friday', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });

    // User marks one revisited and one superseded (the PATCH path).
    const revisited = await decisionsRepo().findOneByOrFail({ normalizedDecision: 'use vendor a' });
    revisited.status = 'revisited';
    await decisionsRepo().save(revisited);
    const superseded = await decisionsRepo().findOneByOrFail({ normalizedDecision: 'ship on friday' });
    superseded.status = 'superseded';
    await decisionsRepo().save(superseded);

    // Re-run re-produces "use vendor A" as active and OMITS "ship on friday".
    // Neither user-owned status may be demoted back to active or reaped.
    const second = await createExtraction(job.inboxItemId, 'decisions', 'queued', new Date('2026-07-01T11:00:00Z'));
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          { decision: 'use vendor A', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: second, inboxItemId: job.inboxItemId });

    const rows = await decisionsRepo().find();
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.normalizedDecision === 'use vendor a')!;
    expect(a.status).toBe('revisited');
    // Provenance still repoints to the latest run.
    expect(a.extractionId).toBe(second);
    const b = rows.find((r) => r.normalizedDecision === 'ship on friday')!;
    expect(b.status).toBe('superseded');
  });

  it('links participants to a matching person registry entity', async () => {
    await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName: 'Anna',
      normalizedName: 'anna',
      aliases: [],
    });
    const job = await seedJob('a decision with anna');
    await buildProcessor(
      fakeProvider(() => ({
        decisions: [
          { decision: 'go ahead', context: null, participants: 'Anna', confidence: null, sourceQuote: null, sourceTimestamp: null },
        ],
        model: 'm',
      })),
    ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId });
    const row = await decisionsRepo().findOneByOrFail({ inboxItemId: job.inboxItemId });
    expect(row.participantEntityId).not.toBeNull();
  });

  it('marks the extraction failed when the provider throws', async () => {
    const job = await seedJob('a decision');
    await expect(
      buildProcessor(
        fakeProvider(() => {
          throw new Error('provider exploded');
        }),
      ).process({ extractionId: job.extractionId, inboxItemId: job.inboxItemId }),
    ).rejects.toThrow('provider exploded');
    const row = await dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id: job.extractionId });
    expect(row.status).toBe('failed');
    expect(await decisionsRepo().count()).toBe(0);
  });
});
