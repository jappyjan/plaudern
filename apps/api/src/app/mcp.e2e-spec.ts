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
import request from 'supertest';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
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

  it('lists the four memory tools', async () => {
    const res = await mcp('tools/list').expect(200);
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['get_item', 'ingest_text_note', 'list_recent_items', 'search_memory']);
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
});
