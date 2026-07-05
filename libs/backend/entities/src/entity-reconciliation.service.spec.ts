import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityMergeSuggestionEntity,
  EntityRegistryEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type { ExtractedEntity } from '@plaudern/contracts';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityReconciliationService } from './entity-reconciliation.service';
import type {
  EntityJudgeInput,
  EntityJudgeProvider,
  EntityJudgeResult,
} from './entity-judge.provider';
import type {
  WebResearchInput,
  WebResearchProvider,
  WebResearchResult,
} from './web-research.provider';

const USER = '00000000-0000-0000-0000-0000000000aa';

/** A judge fake whose enabled state and verdict tests can control. */
class FakeJudge implements EntityJudgeProvider {
  readonly id = 'fake-judge';
  enabled = false;
  lastInput: EntityJudgeInput | null = null;
  decision: EntityJudgeResult['decision'] = {
    sameThing: true,
    recommendedType: 'product',
    survivor: 'subject',
    confidence: 0.9,
    rationale: 'same thing',
  };

  judge(input: EntityJudgeInput): Promise<EntityJudgeResult> {
    this.lastInput = input;
    return Promise.resolve({ decision: this.decision, model: this.id });
  }
}

/** A web-research fake whose enabled state and snippets tests can control. */
class FakeWebResearch implements WebResearchProvider {
  enabled = false;
  lastInput: WebResearchInput | null = null;
  snippets: string[] = [];

  research(input: WebResearchInput): Promise<WebResearchResult> {
    this.lastInput = input;
    return Promise.resolve({ snippets: this.snippets, usedWeb: this.snippets.length > 0 });
  }
}

describe('EntityReconciliationService', () => {
  let dataSource: DataSource;
  let registry: EntitiesRegistryService;
  let reconciliation: EntityReconciliationService;
  let judge: FakeJudge;
  let web: FakeWebResearch;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    registry = new EntitiesRegistryService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(VoiceProfileEntity),
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
    judge = new FakeJudge();
    web = new FakeWebResearch();
    reconciliation = new EntityReconciliationService(
      registry,
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(EntityMergeSuggestionEntity),
      judge,
      web,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Ingest a batch under a fresh item; returns the inbox item id. */
  async function ingest(extracted: ExtractedEntity[]): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const ext = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'entities',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });
    await registry.ingest(USER, item.id, ext.id, extracted);
    return item.id;
  }

  async function idOf(type: string): Promise<string> {
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneOrFail({ where: { userId: USER, type: type as never } });
    return row.id;
  }

  it('surfaces an exact same-name entity of a DIFFERENT type', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const productId = await idOf('product');

    const candidates = await reconciliation.findCandidates(USER, productId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('exact-cross-type');
    expect(candidates[0].score).toBe(1);
    expect(candidates[0].candidate.type).toBe('organization');
    expect(candidates[0].candidate.canonicalName).toBe('Foo');
  });

  it('does NOT surface a same-name SAME-type entity (already deduped) or itself', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Bar', mentions: ['Bar'] },
    ]);
    const orgId = await idOf('organization');

    const candidates = await reconciliation.findCandidates(USER, orgId);
    expect(candidates).toHaveLength(0);
  });

  it('surfaces fuzzy/similar names only when requested', async () => {
    await ingest([
      { type: 'organization', name: 'Foo GmbH', mentions: ['Foo GmbH'] },
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
    ]);
    const gmbh = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneOrFail({ where: { userId: USER, canonicalName: 'Foo GmbH' } });

    // Without fuzzy: nothing (different names, same type, no exact-cross-type).
    expect(await reconciliation.findCandidates(USER, gmbh.id)).toHaveLength(0);

    // With fuzzy: "Foo" is a token-subset of "Foo GmbH" → surfaced.
    const fuzzy = await reconciliation.findCandidates(USER, gmbh.id, { fuzzy: true });
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0].reason).toBe('fuzzy');
    expect(fuzzy[0].candidate.canonicalName).toBe('Foo');
  });

  it('throws NotFound for an unknown entity', async () => {
    await expect(
      reconciliation.findCandidates(USER, '00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('detectExactForItem records a pending suggestion for a same-name cross-type pair, idempotently', async () => {
    // First recording: "Foo" as an organization.
    await ingest([{ type: 'organization', name: 'Foo', mentions: ['Foo'] }]);
    // Later recording: "Foo" as a product — this item now collides.
    const item2 = await ingest([{ type: 'product', name: 'Foo', mentions: ['Foo'] }]);

    const created = await reconciliation.detectExactForItem(USER, item2);
    expect(created).toBe(1);

    const suggestions = await reconciliation.listSuggestions(USER);
    expect(suggestions).toHaveLength(1);
    const [s] = suggestions;
    expect(s.source).toBe('auto');
    expect(s.status).toBe('pending');
    const types = [s.entity.type, s.candidate.type].sort();
    expect(types).toEqual(['organization', 'product']);

    // Running again writes no duplicate (unique canonicalized pair).
    expect(await reconciliation.detectExactForItem(USER, item2)).toBe(0);
    expect(await reconciliation.listSuggestions(USER)).toHaveLength(1);
  });

  it('does not re-create a dismissed suggestion', async () => {
    await ingest([{ type: 'organization', name: 'Foo', mentions: ['Foo'] }]);
    const item2 = await ingest([{ type: 'product', name: 'Foo', mentions: ['Foo'] }]);
    await reconciliation.detectExactForItem(USER, item2);

    const [s] = await reconciliation.listSuggestions(USER);
    await reconciliation.dismiss(USER, s.id);

    expect(await reconciliation.listSuggestions(USER, 'pending')).toHaveLength(0);
    expect(await reconciliation.listSuggestions(USER, 'dismissed')).toHaveLength(1);

    // A later re-detection of the same pair stays dismissed.
    expect(await reconciliation.detectExactForItem(USER, item2)).toBe(0);
    expect(await reconciliation.listSuggestions(USER, 'pending')).toHaveLength(0);
  });

  it('detectExactForItem is a no-op when the item has no cross-type collisions', async () => {
    const item = await ingest([
      { type: 'person', name: 'Alice', mentions: ['Alice'] },
      { type: 'organization', name: 'ACME', mentions: ['ACME'] },
    ]);
    expect(await reconciliation.detectExactForItem(USER, item)).toBe(0);
    expect(await reconciliation.listSuggestions(USER)).toHaveLength(0);
  });

  it('recommend returns null when no judge is configured', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const rows = await dataSource.getRepository(EntityRegistryEntity).find({ where: { userId: USER } });
    const org = rows.find((r) => r.type === 'organization')!;
    const product = rows.find((r) => r.type === 'product')!;

    judge.enabled = false;
    expect(await reconciliation.recommend(USER, product.id, org.id)).toBeNull();
  });

  it('recommend maps the judge verdict and updates the recorded suggestion', async () => {
    await ingest([{ type: 'organization', name: 'Foo', mentions: ['Foo'] }]);
    const item2 = await ingest([{ type: 'product', name: 'Foo', mentions: ['Foo'] }]);
    await reconciliation.detectExactForItem(USER, item2);

    const rows = await dataSource.getRepository(EntityRegistryEntity).find({ where: { userId: USER } });
    const org = rows.find((r) => r.type === 'organization')!;
    const product = rows.find((r) => r.type === 'product')!;

    judge.enabled = true;
    judge.decision = {
      sameThing: true,
      recommendedType: 'product',
      survivor: 'subject',
      confidence: 0.88,
      rationale: 'the real thing is the product',
    };

    const rec = await reconciliation.recommend(USER, product.id, org.id);
    expect(rec).not.toBeNull();
    expect(rec!.sameThing).toBe(true);
    expect(rec!.recommendedType).toBe('product');
    expect(rec!.survivorId).toBe(product.id); // survivor 'subject' = the viewed entity
    expect(rec!.confidence).toBeCloseTo(0.88);

    // The judgment is persisted onto the recorded suggestion.
    const [s] = await reconciliation.listSuggestions(USER);
    expect(s.sameThing).toBe(true);
    expect(s.recommendedType).toBe('product');
    expect(s.recommendedSurvivorId).toBe(product.id);
  });

  it('does not touch the network when web is not requested or is disabled', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const rows = await dataSource.getRepository(EntityRegistryEntity).find({ where: { userId: USER } });
    const org = rows.find((r) => r.type === 'organization')!;
    const product = rows.find((r) => r.type === 'product')!;

    judge.enabled = true;
    web.enabled = true;
    web.snippets = ['Foo is a SaaS product.'];

    // web not requested → no research call, usedWeb false.
    const noWeb = await reconciliation.recommend(USER, product.id, org.id);
    expect(web.lastInput).toBeNull();
    expect(noWeb!.usedWeb).toBe(false);

    // web requested but provider disabled → still no call.
    web.enabled = false;
    await reconciliation.recommend(USER, product.id, org.id, { web: true });
    expect(web.lastInput).toBeNull();
  });

  it('consults web research and passes snippets to the judge when web is on', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const rows = await dataSource.getRepository(EntityRegistryEntity).find({ where: { userId: USER } });
    const org = rows.find((r) => r.type === 'organization')!;
    const product = rows.find((r) => r.type === 'product')!;

    judge.enabled = true;
    web.enabled = true;
    web.snippets = ['Foo is a SaaS product.'];

    const rec = await reconciliation.recommend(USER, product.id, org.id, { web: true });
    expect(rec!.usedWeb).toBe(true);
    // Only the subject name/type + candidate hint leave.
    expect(web.lastInput).toMatchObject({ name: 'Foo', type: 'product' });
    // The judge saw the snippets.
    expect(judge.lastInput?.webSnippets).toEqual(['Foo is a SaaS product.']);
  });
});
