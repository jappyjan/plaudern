import 'reflect-metadata';

// Hardware-free, infra-free verification (see plan §6 Path A). Must run before
// the modules load — ConfigModule reads process.env at init.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import request from 'supertest';
import type { ChatAskResponse, InboxItemDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { AiConfigService } from '@plaudern/ai-config';
import { AiCapabilitySettingEntity, DEFAULT_USER_ID } from '@plaudern/persistence';
import {
  CHAT_COMPLETION_PROVIDER,
  type ChatCompletionMessage,
  type ChatCompletionProvider,
} from '@plaudern/chat';
import { createE2eApp } from '../testing/e2e-app';
import { FakeEmbeddingProvider, FakeSummarizationProvider } from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

/** Scripted chat LLM: shift()s staged replies, records every call. */
class FakeChatProvider implements ChatCompletionProvider {
  readonly id = 'fake-chat';
  calls: ChatCompletionMessage[][] = [];
  replies: string[] = [];

  async complete(_userId: string, messages: ChatCompletionMessage[]) {
    this.calls.push(messages);
    const content = this.replies.shift();
    if (!content) throw new Error('no staged chat reply');
    return { content, model: 'fake-chat-model' };
  }
}

/**
 * End-to-end coverage of memory chat (JJ-37): retrieval through the real
 * hybrid-search pipeline over a really-ingested recording, structural citation
 * enforcement on the LLM reply, conversation persistence, and the
 * disabled-until-configured contract.
 */
describe('Memory chat (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  const chatProvider = new FakeChatProvider();

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(SUMMARIZATION_PROVIDER)
        .useValue(new FakeSummarizationProvider())
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue(new FakeEmbeddingProvider())
        .overrideProvider(CHAT_COMPLETION_PROVIDER)
        .useValue(chatProvider),
    );

    // Enablement is DB-driven now. Chat retrieval runs over embeddings of the
    // ingested recording's transcript+summary, so all three capabilities must
    // be configured for the test user.
    await seedAiCapability(app, 'summarization');
    await seedAiCapability(app, 'embeddings');
    await seedAiCapability(app, 'chat');

    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(idempotencyKey: string): Promise<string> {
    const audio = Buffer.from(`fake-audio-${idempotencyKey}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  /** The pipeline settles on floating promises; wait for the embedding. */
  async function waitForEmbedding(itemId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(200);
      const item = res.body as InboxItemDto;
      const embedding = item.extractions
        .filter((e) => e.kind === 'embedding')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (embedding && ['succeeded', 'failed'].includes(embedding.status)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('embedding did not settle in time');
  }

  it('reports available when a provider is configured', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/chat/status').expect(200);
    expect(res.body).toEqual({ available: true, reason: null });
  });

  it('answers with enforced citations that deep-link to the recording', async () => {
    const itemId = await ingestAudio('e2e-chat-1');
    await waitForEmbedding(itemId);

    // The model cites [1] (valid) and [7] (never provided → must be stripped).
    chatProvider.replies = [
      '{"answer": "The recording is a test transcription of an mpeg upload [1][7].", "confidence": "high"}',
    ];
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat')
      .send({ message: 'what did the test transcription say?' })
      .expect(201);

    const body = res.body as ChatAskResponse;
    expect(body.userMessage.role).toBe('user');
    expect(body.assistantMessage.role).toBe('assistant');
    expect(body.assistantMessage.content).toBe(
      'The recording is a test transcription of an mpeg upload [1].',
    );
    expect(body.assistantMessage.citations).toHaveLength(1);
    expect(body.assistantMessage.citations[0].inboxItemId).toBe(itemId);
    expect(body.assistantMessage.confidence).toBe('high');

    // The model saw the retrieved passage, numbered.
    const answerCall = chatProvider.calls[chatProvider.calls.length - 1];
    const userTurn = answerCall[answerCall.length - 1];
    expect(userTurn.content).toContain('SOURCES:');
    expect(userTurn.content).toContain('[1]');
  });

  it('supports follow-ups: rewrites the question, keeps the conversation', async () => {
    chatProvider.replies = [
      '{"answer": "An mpeg test upload exists [1].", "confidence": "high"}',
    ];
    const first = await request(app.getHttpServer())
      .post('/api/v1/chat')
      .send({ message: 'anything captured about mpeg uploads?' })
      .expect(201);
    const conversationId = (first.body as ChatAskResponse).conversationId;

    chatProvider.replies = [
      '{"queries": ["test transcription mpeg"]}',
      '{"answer": "Yes — it was captured as a test transcription [1].", "confidence": "low"}',
    ];
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat')
      .send({ conversationId, message: 'when was that?' })
      .expect(201);
    const body = res.body as ChatAskResponse;
    expect(body.conversationId).toBe(conversationId);
    expect(body.assistantMessage.confidence).toBe('low');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/chat/conversations/${conversationId}`)
      .expect(200);
    expect(detail.body.messages.length).toBeGreaterThanOrEqual(4);

    const list = await request(app.getHttpServer()).get('/api/v1/chat/conversations').expect(200);
    expect(
      list.body.conversations.some((c: { id: string }) => c.id === conversationId),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/v1/chat/conversations/${conversationId}`)
      .expect(204);
    await request(app.getHttpServer())
      .get(`/api/v1/chat/conversations/${conversationId}`)
      .expect(404);
  });

  it('rejects malformed asks with 400', async () => {
    await request(app.getHttpServer()).post('/api/v1/chat').send({ message: '' }).expect(400);
  });

  it('is disabled (503 + status reason) when the capability is not configured', async () => {
    // Availability is DB-gated now, not a provider flag: explicitly disable the
    // chat capability for the test user and confirm the endpoint reflects it.
    const caps = app.get<Repository<AiCapabilitySettingEntity>>(
      getRepositoryToken(AiCapabilitySettingEntity),
    );
    const aiConfig = app.get(AiConfigService);
    await caps.update({ userId: DEFAULT_USER_ID, capability: 'chat' }, { enabled: false });
    aiConfig.invalidate(DEFAULT_USER_ID);
    try {
      const status = await request(app.getHttpServer()).get('/api/v1/chat/status').expect(200);
      expect(status.body.available).toBe(false);
      expect(status.body.reason).toContain('not configured');
      await request(app.getHttpServer())
        .post('/api/v1/chat')
        .send({ message: 'hello?' })
        .expect(503);
    } finally {
      await caps.update({ userId: DEFAULT_USER_ID, capability: 'chat' }, { enabled: true });
      aiConfig.invalidate(DEFAULT_USER_ID);
    }
  });
});
