import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CommitmentEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  TaskCitationEntity,
  TaskEntity,
} from '@plaudern/persistence';
import type { EmbeddingProvider, EmbeddingResult } from '@plaudern/embeddings';
import { CommitmentTaskDedupeService } from './commitment-task-dedupe.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

/** Embeds each text to a caller-supplied vector; unknown text → far-away zero. */
class FakeEmbeddings implements EmbeddingProvider {
  readonly id = 'fake-embeddings';
  constructor(
    private readonly enabled: boolean,
    private readonly map: Record<string, number[]> = {},
  ) {}
  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }
  async embed(_userId: string, texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((t) => this.map[t] ?? [0, 0, 0]),
      model: this.id,
      dimensions: 3,
    };
  }
}

function config(threshold?: string): ConfigService {
  return {
    get: (_key: string, fallback?: string) => threshold ?? fallback ?? '',
  } as unknown as ConfigService;
}

describe('CommitmentTaskDedupeService', () => {
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

  function build(embeddings: EmbeddingProvider, threshold?: string): CommitmentTaskDedupeService {
    return new CommitmentTaskDedupeService(
      dataSource.getRepository(CommitmentEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(TaskCitationEntity),
      dataSource.getRepository(TaskEntity),
      embeddings,
      config(threshold),
    );
  }

  async function createItem(): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${USER}-${Math.round(performance.now() * 1e6)}`,
      metadata: null,
    });
    return item.id;
  }

  async function createExtraction(inboxItemId: string, kind: 'tasks' | 'commitments'): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version: 1,
      provider: 'test',
      status: 'succeeded',
    });
    return row.id;
  }

  /** Seed a task the item cites (via a succeeded `tasks` extraction). */
  async function createTask(
    inboxItemId: string,
    title: string,
    embedding: number[] | null,
  ): Promise<string> {
    const extractionId = await createExtraction(inboxItemId, 'tasks');
    const task = await dataSource.getRepository(TaskEntity).save({
      userId: USER,
      title,
      normalizedTitle: title.trim().toLowerCase(),
      status: 'open',
      dueDate: null,
      embedding,
      embeddingModel: embedding ? 'fake-embeddings' : null,
      embeddingDimensions: embedding ? embedding.length : null,
    });
    await dataSource.getRepository(TaskCitationEntity).save({
      taskId: task.id,
      inboxItemId,
      extractionId,
      userId: USER,
      quote: null,
      startSeconds: null,
      endSeconds: null,
    });
    return task.id;
  }

  async function createCommitment(
    inboxItemId: string,
    direction: 'owed_by_me' | 'owed_to_me',
    description: string,
    status: 'open' | 'fulfilled' | 'dismissed' = 'open',
  ): Promise<string> {
    const extractionId = await createExtraction(inboxItemId, 'commitments');
    const row = await dataSource.getRepository(CommitmentEntity).save({
      userId: USER,
      inboxItemId,
      extractionId,
      direction,
      counterpartyName: '',
      counterpartyEntityId: null,
      description,
      normalizedDescription: description.trim().toLowerCase(),
      dueDate: null,
      status,
      sourceTimestamp: null,
      sourceQuote: null,
      duplicatesTaskId: null,
    });
    return row.id;
  }

  const flag = async (id: string): Promise<string | null> =>
    (await dataSource.getRepository(CommitmentEntity).findOneByOrFail({ id })).duplicatesTaskId;

  it('stamps an owed_by_me commitment that semantically matches a task', async () => {
    const item = await createItem();
    const taskId = await createTask(item, 'Fill out anamnesis form', [1, 0, 0]);
    const commitmentId = await createCommitment(item, 'owed_by_me', 'Anamnesebogen ausfüllen');

    const service = build(new FakeEmbeddings(true, { 'Anamnesebogen ausfüllen': [0.98, 0.12, 0] }));
    await service.reconcile(USER, item);

    expect(await flag(commitmentId)).toBe(taskId);
  });

  it('never stamps an owed_to_me commitment even if it matches a task', async () => {
    const item = await createItem();
    await createTask(item, 'Send the draft', [1, 0, 0]);
    const owedToMe = await createCommitment(item, 'owed_to_me', 'Send the draft');

    const service = build(new FakeEmbeddings(true, { 'Send the draft': [1, 0, 0] }));
    await service.reconcile(USER, item);

    expect(await flag(owedToMe)).toBeNull();
  });

  it('matches on exact normalized text when embeddings are unavailable', async () => {
    const item = await createItem();
    const taskId = await createTask(item, 'Book the dentist', null);
    const commitmentId = await createCommitment(item, 'owed_by_me', 'Book the dentist');

    const service = build(new FakeEmbeddings(false));
    await service.reconcile(USER, item);

    expect(await flag(commitmentId)).toBe(taskId);
  });

  it('leaves a commitment unstamped when no task is similar enough', async () => {
    const item = await createItem();
    await createTask(item, 'Fill out anamnesis form', [1, 0, 0]);
    const commitmentId = await createCommitment(item, 'owed_by_me', 'Pay the electricity bill');

    const service = build(new FakeEmbeddings(true, { 'Pay the electricity bill': [0.7, 0.7, 0] }));
    await service.reconcile(USER, item);

    // cosine([1,0,0],[0.7,0.7,0]) ≈ 0.707 < 0.8 default threshold.
    expect(await flag(commitmentId)).toBeNull();
  });

  it('clears a stale stamp when the item no longer has any task', async () => {
    const item = await createItem();
    const commitmentId = await createCommitment(item, 'owed_by_me', 'Fill out the form');
    // Pretend a prior run had merged it into some task that is now gone.
    await dataSource
      .getRepository(CommitmentEntity)
      .update(commitmentId, { duplicatesTaskId: '11111111-1111-1111-1111-111111111111' });

    const service = build(new FakeEmbeddings(true));
    await service.reconcile(USER, item);

    expect(await flag(commitmentId)).toBeNull();
  });

  it('does not touch a commitment the user already actioned', async () => {
    const item = await createItem();
    await createTask(item, 'Fill out anamnesis form', [1, 0, 0]);
    const fulfilled = await createCommitment(item, 'owed_by_me', 'Anamnesebogen ausfüllen', 'fulfilled');

    const service = build(new FakeEmbeddings(true, { 'Anamnesebogen ausfüllen': [1, 0, 0] }));
    await service.reconcile(USER, item);

    // Only OPEN owed_by_me rows are reconciled — a fulfilled record stays visible.
    expect(await flag(fulfilled)).toBeNull();
  });

  it('respects a configured threshold', async () => {
    const item = await createItem();
    const taskId = await createTask(item, 'Fill out anamnesis form', [1, 0, 0]);
    const commitmentId = await createCommitment(item, 'owed_by_me', 'related but looser');

    // cosine ≈ 0.707; a 0.6 threshold accepts it, the 0.8 default would not.
    const service = build(new FakeEmbeddings(true, { 'related but looser': [0.7, 0.7, 0] }), '0.6');
    await service.reconcile(USER, item);

    expect(await flag(commitmentId)).toBe(taskId);
  });
});
