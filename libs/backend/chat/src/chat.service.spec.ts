import { randomUUID } from 'node:crypto';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { SearchResultItem } from '@plaudern/contracts';
import type { ChatConversationEntity, ChatMessageEntity } from '@plaudern/persistence';
import type { SearchService } from '@plaudern/search';
import type { ChatCompletionMessage, ChatCompletionProvider } from './chat.provider';
import { ChatService } from './chat.service';

const USER = 'user-1';

/** Just enough of a TypeORM repository for what ChatService actually calls. */
class FakeRepo<T extends { id: string; createdAt?: Date; updatedAt?: Date }> {
  rows: T[] = [];
  private clock = Date.now();

  create(data: Partial<T>): T {
    return { ...data } as T;
  }

  async save(row: T): Promise<T> {
    if (!row.id) {
      row.id = randomUUID();
      row.createdAt = new Date(this.clock);
    }
    row.updatedAt = new Date(this.clock);
    this.clock += 1000; // distinct createdAt per save
    if (!this.rows.includes(row)) this.rows.push(row);
    return row;
  }

  async findOne(opts: { where: Partial<T> }): Promise<T | null> {
    return this.rows.find((row) => matches(row, opts.where)) ?? null;
  }

  async find(opts: {
    where: Partial<T>;
    order?: Record<string, 'ASC' | 'DESC'>;
    take?: number;
  }): Promise<T[]> {
    let rows = this.rows.filter((row) => matches(row, opts.where));
    const [key, dir] = Object.entries(opts.order ?? {})[0] ?? [];
    if (key) {
      rows = rows.slice().sort((a, b) => {
        const av = (a as Record<string, unknown>)[key] as Date;
        const bv = (b as Record<string, unknown>)[key] as Date;
        const cmp = new Date(av).getTime() - new Date(bv).getTime();
        return dir === 'DESC' ? -cmp : cmp;
      });
    }
    return opts.take ? rows.slice(0, opts.take) : rows;
  }

  async delete(where: Partial<T>): Promise<void> {
    this.rows = this.rows.filter((row) => !matches(row, where));
  }
}

function matches<T>(row: T, where: Partial<T>): boolean {
  return Object.entries(where).every(
    ([key, value]) => (row as Record<string, unknown>)[key] === value,
  );
}

class FakeProvider implements ChatCompletionProvider {
  id = 'fake';
  enabled = true;
  calls: ChatCompletionMessage[][] = [];
  replies: string[] = [];

  async complete(messages: ChatCompletionMessage[]) {
    this.calls.push(messages);
    const content = this.replies.shift() ?? '{"answer": "no reply staged", "confidence": "low"}';
    return { content, model: 'fake-model' };
  }
}

class FakeSearch {
  calls: Array<{ query?: string }> = [];
  resultsByQuery = new Map<string, SearchResultItem[]>();
  defaultResults: SearchResultItem[] = [];

  async search(_userId: string, req: { query?: string }) {
    this.calls.push(req);
    const results = this.resultsByQuery.get(req.query ?? '') ?? this.defaultResults;
    return { results, legs: { semantic: 'ran', keyword: 'ran', notes: [] } };
  }
}

function makeHit(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    itemId: randomUUID(),
    title: 'Doctor visit',
    sourceType: 'audio',
    occurredAt: '2026-06-01T10:00:00.000Z',
    snippet: 'the <mark>dosage</mark> is 20mg once per day',
    snippetSource: 'transcript',
    startSeconds: 42.5,
    endSeconds: 61,
    semanticScore: 0.8,
    semanticRank: 1,
    keywordScore: 0.5,
    keywordRank: 1,
    fusedScore: 0.03,
    rank: 1,
    sensitivityTier: null,
    ...overrides,
  };
}

function build(overrides: { provider?: FakeProvider; search?: FakeSearch } = {}) {
  const provider = overrides.provider ?? new FakeProvider();
  const search = overrides.search ?? new FakeSearch();
  const conversations = new FakeRepo<ChatConversationEntity>();
  const messages = new FakeRepo<ChatMessageEntity>();
  const service = new ChatService(
    provider,
    search as unknown as SearchService,
    conversations as unknown as Repository<ChatConversationEntity>,
    messages as unknown as Repository<ChatMessageEntity>,
  );
  return { service, provider, search, conversations, messages };
}

describe('ChatService.status', () => {
  it('reports unavailable with an actionable reason when the provider is disabled', () => {
    const provider = new FakeProvider();
    provider.enabled = false;
    const { service } = build({ provider });
    const status = service.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('CHAT_API_KEY');
  });
});

describe('ChatService.ask', () => {
  it('rejects when the provider is disabled (feature ships off)', async () => {
    const provider = new FakeProvider();
    provider.enabled = false;
    const { service } = build({ provider });
    await expect(service.ask(USER, { message: 'anything' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers "not found" WITHOUT calling the LLM when retrieval is empty', async () => {
    const { service, provider } = build();
    const res = await service.ask(USER, { message: 'What is the wifi password?' });
    expect(provider.calls).toHaveLength(0); // no sources → no generation
    expect(res.assistantMessage.content).toContain("couldn't find");
    expect(res.assistantMessage.citations).toEqual([]);
    expect(res.userMessage.role).toBe('user');
    expect(res.conversationId).toBeTruthy();
  });

  it('maps cited markers to sources, strips invented ones, renumbers densely', async () => {
    const { service, provider, search } = build();
    const hitA = makeHit({ fusedScore: 0.05 });
    const hitB = makeHit({ title: 'Pharmacy call', startSeconds: null, endSeconds: null });
    search.defaultResults = [hitA, hitB];
    provider.replies = [
      '{"answer": "The dosage is 20mg daily [2]. It was prescribed in June [9][1].", "confidence": "high"}',
    ];

    const res = await service.ask(USER, { message: 'What did the doctor say about the dosage?' });
    const msg = res.assistantMessage;
    // [2] → 1, [9] stripped, [1] → 2.
    expect(msg.content).toBe('The dosage is 20mg daily [1]. It was prescribed in June [2].');
    expect(msg.citations.map((c) => c.marker)).toEqual([1, 2]);
    expect(msg.citations[0].inboxItemId).toBe(hitB.itemId);
    expect(msg.citations[1].inboxItemId).toBe(hitA.itemId);
    expect(msg.citations[1].startSeconds).toBe(42.5);
    // Highlight markup never leaks into the stored passage.
    expect(msg.citations[1].snippet).not.toContain('<mark>');
    expect(msg.confidence).toBe('high');
  });

  it('downgrades to low confidence when a substantive claim is uncited', async () => {
    const { service, provider, search } = build();
    search.defaultResults = [makeHit()];
    provider.replies = [
      '{"answer": "The dosage is 20mg daily [1]. The doctor also recommended taking it together with a full meal.", "confidence": "high"}',
    ];
    const res = await service.ask(USER, { message: 'dosage?' });
    expect(res.assistantMessage.confidence).toBe('low');
  });

  it('replaces an entirely uncited answer instead of asserting it', async () => {
    const { service, provider, search } = build();
    search.defaultResults = [makeHit(), makeHit(), makeHit(), makeHit()];
    provider.replies = [
      '{"answer": "The doctor said the medication should be taken twice per day.", "confidence": "high"}',
    ];
    const res = await service.ask(USER, { message: 'dosage?' });
    const msg = res.assistantMessage;
    expect(msg.content).toContain("won't state it as fact");
    expect(msg.confidence).toBe('low');
    // The nearest sources are still attached so the user can check the memory.
    expect(msg.citations).toHaveLength(3);
    expect(msg.citations.map((c) => c.marker)).toEqual([1, 2, 3]);
  });

  it('rewrites follow-up questions into standalone retrieval queries', async () => {
    const { service, provider, search } = build();
    search.defaultResults = [makeHit()];
    provider.replies = [
      '{"answer": "He prescribed 20mg [1].", "confidence": "high"}',
      '{"queries": ["doctor dosage prescription"]}',
      '{"answer": "Once per day [1].", "confidence": "high"}',
    ];

    const first = await service.ask(USER, { message: 'What did the doctor prescribe?' });
    // Turn 1: no history → no rewrite call, one answer call.
    expect(provider.calls).toHaveLength(1);

    await service.ask(USER, {
      conversationId: first.conversationId,
      message: 'How often should I take it?',
    });
    // Turn 2: rewrite + answer.
    expect(provider.calls).toHaveLength(3);
    const queries = search.calls.map((c) => c.query);
    expect(queries).toContain('How often should I take it?');
    expect(queries).toContain('doctor dosage prescription');
  });

  it('scopes conversations per user', async () => {
    const { service, search, provider } = build();
    search.defaultResults = [makeHit()];
    provider.replies = ['{"answer": "A [1].", "confidence": "high"}'];
    const res = await service.ask(USER, { message: 'first question' });
    await expect(
      service.ask('someone-else', { conversationId: res.conversationId, message: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getConversation('someone-else', res.conversationId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('persists the exchange so the conversation replays with citations', async () => {
    const { service, search, provider } = build();
    search.defaultResults = [makeHit()];
    provider.replies = ['{"answer": "The rent goes up in March [1].", "confidence": "high"}'];
    const res = await service.ask(USER, { message: 'When does the rent go up?' });

    const detail = await service.getConversation(USER, res.conversationId);
    expect(detail.conversation.title).toBe('When does the rent go up?');
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].role).toBe('user');
    expect(detail.messages[1].role).toBe('assistant');
    expect(detail.messages[1].citations).toHaveLength(1);

    const list = await service.listConversations(USER);
    expect(list.conversations).toHaveLength(1);

    await service.deleteConversation(USER, res.conversationId);
    await expect(service.getConversation(USER, res.conversationId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
