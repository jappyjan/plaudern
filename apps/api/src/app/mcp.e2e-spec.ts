import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init).
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — MCP does its own token auth
process.env.APP_ENCRYPTION_SECRET = 'test-secret';
process.env.PLAUD_POLL_INTERVAL_MS = '0';

import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
import { InboxService } from '@plaudern/inbox';
import { TasksRegistryService } from '@plaudern/tasks';
import {
  AiProviderCallEntity,
  CommitmentEntity,
  DEFAULT_USER_ID,
  ItemSensitivityEntity,
  QuestionEntity,
} from '@plaudern/persistence';
import type { SensitivityTier } from '@plaudern/contracts';
import { createE2eApp } from '../testing/e2e-app';
import { FakeEmbeddingProvider } from '../testing/fake-providers';

const MCP_HEADERS = {
  'content-type': 'application/json',
  // The Streamable HTTP transport requires POSTs to accept both content types.
  accept: 'application/json, text/event-stream',
};

/**
 * End-to-end coverage of the MCP endpoint (JJ-14): per-user Bearer auth at the
 * API layer, the four memory tools reachable over the Streamable HTTP transport,
 * and a note captured through MCP surfacing in the same user's inbox.
 */
describe('MCP server (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(EMBEDDING_PROVIDER).useValue(new FakeEmbeddingProvider()),
    );
    // Mint the caller's MCP token via the session-authenticated settings route
    // (acting user is DEFAULT_USER_ID under AUTH_DISABLED).
    const minted = await request(app.getHttpServer())
      .post('/api/v1/settings/mcp/token')
      .expect(201);
    token = minted.body.token;
    expect(token).toMatch(/^mcp_/);
    expect(minted.body).not.toHaveProperty('tokenHash');
  });

  afterAll(async () => {
    await app.close();
  });

  let rpcId = 0;
  function mcp(method: string, params: Record<string, unknown> = {}, bearer = token) {
    return request(app.getHttpServer())
      .post('/api/mcp')
      .set({ ...MCP_HEADERS, authorization: `Bearer ${bearer}` })
      .send({ jsonrpc: '2.0', id: ++rpcId, method, params });
  }

  /** Unwrap a tools/call text result back into its structured payload. */
  function toolPayload(body: { result?: { content?: Array<{ text: string }> } }): unknown {
    const text = body.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : undefined;
  }

  it('rejects requests without a valid Bearer token', async () => {
    await request(app.getHttpServer())
      .post('/api/mcp')
      .set(MCP_HEADERS)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/mcp')
      .set({ ...MCP_HEADERS, authorization: 'Bearer mcp_wrong' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(401);
  });

  it('lists the memory + knowledge-graph read tools plus the mutation tools', async () => {
    const res = await mcp('tools/list').expect(200);
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    // The memory tools + JJ-78 knowledge-graph read tools + the JJ-78 follow-up
    // mutation tools. Asserted in full (sorted) so the external surface stays guarded.
    expect(names).toEqual([
      'answer_question',
      'create_task',
      'get_entity',
      'get_item',
      'get_journal',
      'get_topic',
      'ingest_text_note',
      'list_calendar_events',
      'list_commitments',
      'list_decisions',
      'list_entities',
      'list_facts',
      'list_journal_periods',
      'list_questions',
      'list_recent_items',
      'list_relations',
      'list_reminders',
      'list_tasks',
      'list_topics',
      'search_memory',
      'update_commitment_status',
      'update_task_status',
    ]);
  });

  it('captures a note through ingest_text_note and surfaces it in the inbox', async () => {
    const res = await mcp('tools/call', {
      name: 'ingest_text_note',
      arguments: { text: 'buy oat milk on the way home' },
    }).expect(200);

    const payload = toolPayload(res.body) as { itemId: string };
    expect(payload.itemId).toBeTruthy();

    // The note is a real inbox item owned by the same user.
    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    const ids = inbox.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(payload.itemId);
  });

  it('lists recent items including the captured note', async () => {
    const res = await mcp('tools/call', {
      name: 'list_recent_items',
      arguments: { limit: 10 },
    }).expect(200);

    const payload = toolPayload(res.body) as {
      items: Array<{ itemId: string; sourceType: string }>;
    };
    expect(payload.items.some((i) => i.sourceType === 'text')).toBe(true);
  });

  it('get_item returns not-found content for an unknown id (scoped to the user)', async () => {
    const res = await mcp('tools/call', {
      name: 'get_item',
      arguments: { itemId: '00000000-0000-0000-0000-0000000000ff' },
    }).expect(200);
    // Tool errors are surfaced as an error result, not a transport failure.
    expect(res.body.result.isError).toBe(true);
  });

  it('search_memory runs and returns a result array', async () => {
    const res = await mcp('tools/call', {
      name: 'search_memory',
      arguments: { query: 'oat milk', limit: 5 },
    }).expect(200);
    const payload = toolPayload(res.body);
    expect(Array.isArray(payload)).toBe(true);
  });

  // ---- JJ-78 follow-up: mutation tools ----

  /**
   * Seed a source item at a chosen sensitivity tier. Ingesting a note already
   * runs the sentinel inline (the detector pass creates an item_sensitivity row),
   * so we UPSERT its effective tier to `tier` — `normal` to make the item cross
   * the external surface, `secret` to make it local-only (gated, so a mutation
   * must be refused). (The NO-row-yet fail-closed path is covered by the tools
   * unit test, where the tier map can be left empty.)
   */
  async function seedItem(tier: SensitivityTier): Promise<string> {
    const note = await mcp('tools/call', {
      name: 'ingest_text_note',
      arguments: { text: 'seed note for a mutation round-trip' },
    }).expect(200);
    const { itemId } = toolPayload(note.body) as { itemId: string };
    const rows = app.get<Repository<ItemSensitivityEntity>>(
      getRepositoryToken(ItemSensitivityEntity),
    );
    const existing = await rows.findOne({ where: { inboxItemId: itemId } });
    if (existing) {
      existing.detectedTier = tier;
      existing.manualTier = null;
      await rows.save(existing);
    } else {
      const inbox = app.get(InboxService);
      const extraction = await inbox.addExtraction(itemId, 'sentinel', 'test-sentinel', 1);
      await rows.save(
        rows.create({
          userId: DEFAULT_USER_ID,
          inboxItemId: itemId,
          extractionId: extraction.id,
          detectedTier: tier,
        }),
      );
    }
    return itemId;
  }

  async function seedCommitment(tier: SensitivityTier): Promise<string> {
    const itemId = await seedItem(tier);
    const inbox = app.get(InboxService);
    const extraction = await inbox.addExtraction(itemId, 'commitments', 'test', 3);
    const repo = app.get<Repository<CommitmentEntity>>(getRepositoryToken(CommitmentEntity));
    const row = await repo.save(
      repo.create({
        userId: DEFAULT_USER_ID,
        inboxItemId: itemId,
        extractionId: extraction.id,
        direction: 'owed_by_me',
        counterpartyName: 'Alex',
        description: 'send the report',
        normalizedDescription: 'send the report',
        status: 'open',
      }),
    );
    return row.id;
  }

  async function seedQuestion(tier: SensitivityTier): Promise<string> {
    const itemId = await seedItem(tier);
    const inbox = app.get(InboxService);
    const extraction = await inbox.addExtraction(itemId, 'questions', 'test', 2);
    const repo = app.get<Repository<QuestionEntity>>(getRepositoryToken(QuestionEntity));
    const row = await repo.save(
      repo.create({
        userId: DEFAULT_USER_ID,
        inboxItemId: itemId,
        extractionId: extraction.id,
        direction: 'asked_of_me',
        counterpartyName: 'Sam',
        question: 'can you send it today?',
        normalizedQuestion: 'can you send it today',
        status: 'open',
      }),
    );
    return row.id;
  }

  it('create_task creates a user-owned task surfaced by list_tasks and audited', async () => {
    const created = await mcp('tools/call', {
      name: 'create_task',
      arguments: { title: 'MCP round-trip task' },
    }).expect(200);
    const task = toolPayload(created.body) as { id: string; status: string };
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('open');

    // Read back: a citation-less user-created task surfaces over the external gate.
    const listed = await mcp('tools/call', {
      name: 'list_tasks',
      arguments: { limit: 50 },
    }).expect(200);
    const payload = toolPayload(listed.body) as { tasks: Array<{ id: string }> };
    expect(payload.tasks.some((t) => t.id === task.id)).toBe(true);

    // Audited into the shared trail, tagged with the acting token's prefix.
    const audit = app.get<Repository<AiProviderCallEntity>>(
      getRepositoryToken(AiProviderCallEntity),
    );
    const rows = await audit.find({ where: { provider: 'mcp' } });
    const entry = rows.find((r) => r.kind === 'mcp:create_task');
    expect(entry).toBeTruthy();
    expect(entry?.endpoint).toBe(token.slice(0, 8));
    expect(entry?.direction).toBe('inbound');
  });

  it('update_task_status flips a task and list_tasks reflects the new status', async () => {
    const created = await mcp('tools/call', {
      name: 'create_task',
      arguments: { title: 'task to complete over MCP' },
    }).expect(200);
    const task = toolPayload(created.body) as { id: string };

    const updated = await mcp('tools/call', {
      name: 'update_task_status',
      arguments: { taskId: task.id, status: 'completed' },
    }).expect(200);
    expect((toolPayload(updated.body) as { status: string }).status).toBe('completed');

    const listed = await mcp('tools/call', {
      name: 'list_tasks',
      arguments: { limit: 50, status: 'completed' },
    }).expect(200);
    const payload = toolPayload(listed.body) as { tasks: Array<{ id: string; status: string }> };
    expect(payload.tasks.some((t) => t.id === task.id && t.status === 'completed')).toBe(true);
  });

  it('update_task_status uses a race-safe conditional flip (stale expected loses)', async () => {
    // Proven at the service level, where the expected-status guard is observable:
    // an UPDATE whose expected status no longer matches changes zero rows.
    const registry = app.get(TasksRegistryService);
    const task = await registry.createUserTask(DEFAULT_USER_ID, { title: 'race-safe subject' });

    const won = await registry.setStatusIfUnchanged(DEFAULT_USER_ID, task.id, 'open', 'completed');
    expect(won.status).toBe('completed');

    // A second writer that still thinks the task is 'open' must NOT clobber it.
    await expect(
      registry.setStatusIfUnchanged(DEFAULT_USER_ID, task.id, 'open', 'dismissed'),
    ).rejects.toThrow(/concurrently/);
  });

  it('update_commitment_status flips an allowed commitment and persists it', async () => {
    const commitmentId = await seedCommitment('normal');
    const res = await mcp('tools/call', {
      name: 'update_commitment_status',
      arguments: { commitmentId, status: 'fulfilled' },
    }).expect(200);
    expect((toolPayload(res.body) as { status: string }).status).toBe('fulfilled');

    const repo = app.get<Repository<CommitmentEntity>>(getRepositoryToken(CommitmentEntity));
    const row = await repo.findOne({ where: { id: commitmentId } });
    expect(row?.status).toBe('fulfilled');
  });

  it('refuses a commitment mutation on a local-only (gated) item (fail closed)', async () => {
    const commitmentId = await seedCommitment('secret'); // local-only ⇒ gated
    const res = await mcp('tools/call', {
      name: 'update_commitment_status',
      arguments: { commitmentId, status: 'fulfilled' },
    }).expect(200);
    expect(res.body.result.isError).toBe(true);

    // The write was refused — the row is untouched.
    const repo = app.get<Repository<CommitmentEntity>>(getRepositoryToken(CommitmentEntity));
    const row = await repo.findOne({ where: { id: commitmentId } });
    expect(row?.status).toBe('open');
  });

  it('answer_question marks an allowed question answered and list_questions reflects it', async () => {
    const questionId = await seedQuestion('normal');
    const res = await mcp('tools/call', {
      name: 'answer_question',
      arguments: { questionId, answer: 'yes — sending it at 3pm' },
    }).expect(200);
    expect((toolPayload(res.body) as { status: string }).status).toBe('answered');

    const listed = await mcp('tools/call', {
      name: 'list_questions',
      arguments: { limit: 50, status: 'answered' },
    }).expect(200);
    const payload = toolPayload(listed.body) as { questions: Array<{ id: string; status: string }> };
    expect(payload.questions.some((q) => q.id === questionId && q.status === 'answered')).toBe(true);
  });

  it('refuses answering a question on a sensitive item (fail closed)', async () => {
    const questionId = await seedQuestion('secret');
    const res = await mcp('tools/call', {
      name: 'answer_question',
      arguments: { questionId, answer: 'nope' },
    }).expect(200);
    expect(res.body.result.isError).toBe(true);

    const repo = app.get<Repository<QuestionEntity>>(getRepositoryToken(QuestionEntity));
    const row = await repo.findOne({ where: { id: questionId } });
    expect(row?.status).toBe('open');
  });
});
