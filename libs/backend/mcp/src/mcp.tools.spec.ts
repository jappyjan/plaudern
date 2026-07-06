import { NotFoundException } from '@nestjs/common';
import type { InboxItemEntity } from '@plaudern/persistence';
import type { SearchResponse } from '@plaudern/contracts';
import { McpToolsService } from './mcp.tools';

type Fakes = {
  inbox: { getItem: jest.Mock; listItems: jest.Mock };
  search: { search: jest.Mock };
  ingestion: { ingestText: jest.Mock };
  sensitivity: { effectiveTiers: jest.Mock };
  entitiesRegistry: { list: jest.Mock; mentionItemIds: jest.Mock };
  entityGraph: { edgesFor: jest.Mock };
  dossier: { build: jest.Mock };
  facts: { listWithCitations: jest.Mock };
  tasks: { list: jest.Mock; citationItemIds: jest.Mock };
  commitments: { list: jest.Mock };
  questions: { list: jest.Mock };
  decisions: { list: jest.Mock };
  reminders: { list: jest.Mock };
  topics: { listTopics: jest.Mock; listItemsByTopic: jest.Mock };
  journal: { listPeriods: jest.Mock; getJournal: jest.Mock };
  calendar: { eventsInRange: jest.Mock };
};

function build(): { service: McpToolsService; fakes: Fakes } {
  const fakes: Fakes = {
    inbox: { getItem: jest.fn(), listItems: jest.fn() },
    search: { search: jest.fn() },
    ingestion: { ingestText: jest.fn() },
    // JJ-78 knowledge-graph read deps + the JJ-21 sensitivity gate.
    sensitivity: { effectiveTiers: jest.fn().mockResolvedValue(new Map()) },
    entitiesRegistry: { list: jest.fn(), mentionItemIds: jest.fn() },
    entityGraph: { edgesFor: jest.fn() },
    dossier: { build: jest.fn() },
    facts: { listWithCitations: jest.fn() },
    tasks: { list: jest.fn(), citationItemIds: jest.fn() },
    commitments: { list: jest.fn() },
    questions: { list: jest.fn() },
    decisions: { list: jest.fn() },
    reminders: { list: jest.fn() },
    topics: { listTopics: jest.fn(), listItemsByTopic: jest.fn() },
    journal: { listPeriods: jest.fn(), getJournal: jest.fn() },
    calendar: { eventsInRange: jest.fn() },
  };
  const service = new McpToolsService(
    fakes.inbox as never,
    fakes.search as never,
    fakes.ingestion as never,
    fakes.sensitivity as never,
    fakes.entitiesRegistry as never,
    fakes.entityGraph as never,
    fakes.dossier as never,
    fakes.facts as never,
    fakes.tasks as never,
    fakes.commitments as never,
    fakes.questions as never,
    fakes.decisions as never,
    fakes.reminders as never,
    fakes.topics as never,
    fakes.journal as never,
    fakes.calendar as never,
  );
  return { service, fakes };
}

/** effectiveTiers fake: any item id present maps to its tier; absent ⇒ null. */
function tierMap(entries: Record<string, 'public' | 'normal' | 'sensitive' | 'secret'>): jest.Mock {
  return jest.fn(async (ids: string[]) => {
    const map = new Map<string, string>();
    for (const id of ids) if (entries[id]) map.set(id, entries[id]);
    return map;
  });
}

function summaryContent(over: Partial<{ title: string; layout: string; markdown: string }> = {}) {
  return JSON.stringify({
    title: over.title ?? 'Standup notes',
    layout: over.layout ?? 'meeting',
    markdown: over.markdown ?? '# Decisions\n- ship it',
  });
}

function item(over: Partial<InboxItemEntity> = {}): InboxItemEntity {
  return {
    id: over.id ?? 'item-1',
    userId: 'user-1',
    sourceType: over.sourceType ?? 'audio',
    occurredAt: over.occurredAt ?? '2026-07-01T09:00:00.000Z',
    ingestedAt: over.ingestedAt ?? '2026-07-01T09:05:00.000Z',
    metadata: over.metadata ?? null,
    extractions: over.extractions ?? [],
  } as unknown as InboxItemEntity;
}

function extraction(over: Record<string, unknown>) {
  return {
    id: over.id ?? 'ex-1',
    kind: over.kind,
    status: over.status ?? 'succeeded',
    content: over.content ?? null,
    createdAt: over.createdAt ?? '2026-07-01T09:06:00.000Z',
    ...over,
  };
}

describe('McpToolsService', () => {
  describe('searchMemory', () => {
    it('maps hybrid search results to snippets, stripping highlight markers', async () => {
      const { service, fakes } = build();
      const response: SearchResponse = {
        results: [
          {
            itemId: 'item-9',
            title: 'Launch plan',
            sourceType: 'audio',
            occurredAt: '2026-07-01T09:00:00.000Z',
            snippet: 'we agreed to <mark>launch</mark> on Friday',
            snippetSource: 'transcript',
            startSeconds: 12.5,
            endSeconds: 20,
            semanticScore: 0.87,
            semanticRank: 1,
            keywordScore: 0.12,
            keywordRank: 1,
            fusedScore: 0.0328,
            rank: 1,
            sensitivityTier: 'normal',
          },
        ],
        legs: { semantic: 'ran', keyword: 'ran', notes: [] },
      };
      fakes.search.search.mockResolvedValue(response);

      const result = await service.searchMemory('user-1', { query: 'launch date', limit: 5 });

      expect(fakes.search.search).toHaveBeenCalledWith('user-1', {
        query: 'launch date',
        limit: 5,
      });
      expect(result).toEqual([
        {
          itemId: 'item-9',
          source: 'transcript',
          snippet: 'we agreed to launch on Friday',
          score: 0.0328,
          startSeconds: 12.5,
          endSeconds: 20,
        },
      ]);
    });

    it('falls back to a summary source when a result has no snippet source', async () => {
      const { service, fakes } = build();
      const response: SearchResponse = {
        results: [
          {
            itemId: 'item-1',
            title: null,
            sourceType: 'text',
            occurredAt: '2026-07-01T09:00:00.000Z',
            snippet: null,
            snippetSource: null,
            startSeconds: null,
            endSeconds: null,
            semanticScore: null,
            semanticRank: null,
            keywordScore: 0.2,
            keywordRank: 1,
            fusedScore: 0.0164,
            rank: 1,
            sensitivityTier: 'normal',
          },
        ],
        legs: { semantic: 'unavailable', keyword: 'ran', notes: ['semantic unavailable'] },
      };
      fakes.search.search.mockResolvedValue(response);

      const result = await service.searchMemory('user-1', { query: 'note', limit: 5 });
      expect(result[0]).toMatchObject({ itemId: 'item-1', source: 'summary', snippet: '' });
    });

    it('excludes sensitive AND not-yet-classified (null tier) items — fail closed (JJ-21)', async () => {
      const { service, fakes } = build();
      const hit = (
        itemId: string,
        sensitivityTier: SearchResponse['results'][number]['sensitivityTier'],
      ): SearchResponse['results'][number] => ({
        itemId,
        title: itemId,
        sourceType: 'audio',
        occurredAt: '2026-07-01T09:00:00.000Z',
        snippet: `secret text for ${itemId}`,
        snippetSource: 'transcript',
        startSeconds: null,
        endSeconds: null,
        semanticScore: null,
        semanticRank: null,
        keywordScore: 0.2,
        keywordRank: 1,
        fusedScore: 0.02,
        rank: 1,
        sensitivityTier,
      });
      fakes.search.search.mockResolvedValue({
        results: [hit('secret-item', 'secret'), hit('unclassified-item', null), hit('ok-item', 'normal')],
        legs: { semantic: 'ran', keyword: 'ran', notes: [] },
      });

      const result = await service.searchMemory('user-1', { query: 'anything', limit: 5 });
      expect(result.map((r) => r.itemId)).toEqual(['ok-item']);
    });
  });

  describe('getItem', () => {
    it('returns transcript, summary and metadata, scoped to the user', async () => {
      const { service, fakes } = build();
      fakes.inbox.getItem.mockResolvedValue(
        item({
          id: 'item-1',
          metadata: { location: 'Berlin' },
          extractions: [
            extraction({ kind: 'transcription', content: 'full transcript text' }),
            extraction({ kind: 'summary', content: summaryContent() }),
          ] as never,
        }),
      );

      const result = await service.getItem('user-1', { itemId: 'item-1' });

      expect(fakes.inbox.getItem).toHaveBeenCalledWith('user-1', 'item-1');
      expect(result.transcript).toBe('full transcript text');
      expect(result.summary).toEqual({
        title: 'Standup notes',
        layout: 'meeting',
        markdown: '# Decisions\n- ship it',
      });
      expect(result.title).toBe('Standup notes');
      expect(result.metadata).toEqual({ location: 'Berlin' });
    });

    it('prefers a metadata tag title over the summary title', async () => {
      const { service, fakes } = build();
      fakes.inbox.getItem.mockResolvedValue(
        item({
          metadata: { tags: { title: 'Weekly sync' } },
          extractions: [extraction({ kind: 'summary', content: summaryContent() })] as never,
        }),
      );

      const result = await service.getItem('user-1', { itemId: 'item-1' });
      expect(result.title).toBe('Weekly sync');
    });

    it('ignores non-succeeded transcriptions and returns null transcript', async () => {
      const { service, fakes } = build();
      fakes.inbox.getItem.mockResolvedValue(
        item({
          extractions: [
            extraction({ kind: 'transcription', status: 'processing', content: null }),
          ] as never,
        }),
      );

      const result = await service.getItem('user-1', { itemId: 'item-1' });
      expect(result.transcript).toBeNull();
      expect(result.summary).toBeNull();
      expect(result.title).toBeNull();
    });

    it('propagates a not-found from the inbox (foreign/unknown ids never leak)', async () => {
      const { service, fakes } = build();
      fakes.inbox.getItem.mockRejectedValue(new NotFoundException('inbox item not found'));
      await expect(service.getItem('user-1', { itemId: 'nope' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listRecentItems', () => {
    it('returns compact entries with flags and passes cursor through', async () => {
      const { service, fakes } = build();
      fakes.inbox.listItems.mockResolvedValue({
        items: [
          item({
            id: 'item-1',
            extractions: [
              extraction({ kind: 'transcription', content: 'text' }),
              extraction({ kind: 'summary', content: summaryContent({ title: 'A' }) }),
            ] as never,
          }),
          item({ id: 'item-2', sourceType: 'text', extractions: [] }),
        ],
        nextCursor: 'item-2',
      });

      const result = await service.listRecentItems('user-1', { limit: 20, cursor: 'abc' });

      expect(fakes.inbox.listItems).toHaveBeenCalledWith('user-1', 20, 'abc');
      expect(result.nextCursor).toBe('item-2');
      expect(result.items[0]).toMatchObject({
        itemId: 'item-1',
        title: 'A',
        hasTranscript: true,
        hasSummary: true,
      });
      expect(result.items[1]).toMatchObject({
        itemId: 'item-2',
        sourceType: 'text',
        title: null,
        hasTranscript: false,
        hasSummary: false,
      });
    });
  });

  describe('ingestTextNote', () => {
    it('captures a note via the ingestion text path and returns its id', async () => {
      const { service, fakes } = build();
      fakes.ingestion.ingestText.mockResolvedValue({ id: 'note-1' });

      const result = await service.ingestTextNote('user-1', { text: 'remember the milk' });

      expect(result).toEqual({ itemId: 'note-1' });
      const [userId, req] = fakes.ingestion.ingestText.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(req.text).toBe('remember the milk');
      expect(typeof req.occurredAt).toBe('string');
      expect(req.idempotencyKey).toMatch(/^mcp-note-/);
    });

    it('honors a caller-supplied occurredAt and idempotencyKey', async () => {
      const { service, fakes } = build();
      fakes.ingestion.ingestText.mockResolvedValue({ id: 'note-2' });

      await service.ingestTextNote('user-1', {
        text: 'pinned',
        occurredAt: '2026-01-02T03:04:05.000Z',
        idempotencyKey: 'fixed-key',
      });

      const [, req] = fakes.ingestion.ingestText.mock.calls[0];
      expect(req.occurredAt).toBe('2026-01-02T03:04:05.000Z');
      expect(req.idempotencyKey).toBe('fixed-key');
    });
  });

  // ---- JJ-78 knowledge-graph tools: user-scoping + sensitivity gate ----

  function entity(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: over.id ?? 'e-1',
      type: over.type ?? 'person',
      canonicalName: over.canonicalName ?? 'Alice',
      aliases: over.aliases ?? [],
      voiceProfileId: null,
      voiceProfileLinkOrigin: null,
      voiceProfileName: (over.voiceProfileName as string | null) ?? null,
      mentionCount: (over.mentionCount as number) ?? 1,
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: (over.lastSeenAt as string) ?? '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    };
  }

  describe('listEntities (sensitivity gate)', () => {
    it('hides an entity whose only source item is sensitive, and passes userId through', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.list.mockResolvedValue([
        entity({ id: 'e-ok', canonicalName: 'Alice' }),
        entity({ id: 'e-secret', canonicalName: 'Bob' }),
        entity({ id: 'e-unclassified', canonicalName: 'Carol' }),
      ]);
      fakes.entitiesRegistry.mentionItemIds.mockResolvedValue(
        new Map([
          ['e-ok', ['item-ok']],
          ['e-secret', ['item-secret']],
          ['e-unclassified', ['item-new']],
        ]),
      );
      // item-ok is normal; item-secret is secret; item-new has NO tier row (null).
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-ok': 'normal', 'item-secret': 'secret' });

      const result = await service.listEntities('user-1', { limit: 20 });

      expect(fakes.entitiesRegistry.list).toHaveBeenCalledWith('user-1', undefined);
      expect(fakes.entitiesRegistry.mentionItemIds).toHaveBeenCalledWith('user-1', [
        'e-ok',
        'e-secret',
        'e-unclassified',
      ]);
      // Only the entity backed by a classified, non-local-only item survives —
      // the sensitive one AND the not-yet-classified (null tier) one are dropped.
      expect(result.entities.map((e) => e.id)).toEqual(['e-ok']);
    });

    it('applies the name/alias query filter case-insensitively', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.list.mockResolvedValue([
        entity({ id: 'e-a', canonicalName: 'Angela Merkel', aliases: [] }),
        entity({ id: 'e-b', canonicalName: 'Bob', aliases: ['Bobby'] }),
      ]);
      fakes.entitiesRegistry.mentionItemIds.mockResolvedValue(
        new Map([
          ['e-a', ['i-a']],
          ['e-b', ['i-b']],
        ]),
      );
      fakes.sensitivity.effectiveTiers = tierMap({ 'i-a': 'normal', 'i-b': 'normal' });

      const result = await service.listEntities('user-1', { query: 'merkel', limit: 20 });
      expect(result.entities.map((e) => e.id)).toEqual(['e-a']);
    });
  });

  describe('getEntity (sensitivity gate)', () => {
    it('404s when the entity has no externally-visible mention', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.mentionItemIds.mockResolvedValue(new Map([['e-1', ['item-secret']]]));
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-secret': 'secret' });

      await expect(service.getEntity('user-1', { entityId: 'e-1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fakes.dossier.build).not.toHaveBeenCalled();
    });

    it('drops sensitive citations, commitments, questions and mentions from the dossier', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.mentionItemIds
        // first call: visibility check for the entity itself (has a normal item)
        .mockResolvedValueOnce(new Map([['e-1', ['ok']]]))
        // second call (inside redactDossier): neighbor visibility — none visible
        .mockResolvedValueOnce(new Map([['n-1', ['secret']]]));
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });
      fakes.dossier.build.mockResolvedValue({
        entity: { id: 'e-1', type: 'person', canonicalName: 'Alice' },
        facts: {
          active: [
            { id: 'f-ok', citations: [{ inboxItemId: 'ok' }] },
            { id: 'f-secret', citations: [{ inboxItemId: 'secret' }] },
          ],
          superseded: [],
        },
        commitments: {
          owedByMe: [{ id: 'c-ok', inboxItemId: 'ok' }],
          owedToMe: [{ id: 'c-secret', inboxItemId: 'secret' }],
        },
        openQuestions: [{ id: 'q-secret', inboxItemId: 'secret' }],
        relations: [{ sourceEntityId: 'e-1', targetEntityId: 'n-1', relationType: 'related_to' }],
        neighbors: [{ id: 'n-1', type: 'person', canonicalName: 'Neighbor' }],
        recentItems: [
          { inboxItemId: 'ok', title: 't' },
          { inboxItemId: 'secret', title: 't' },
        ],
        counts: {},
      });

      const result = await service.getEntity('user-1', { entityId: 'e-1' });

      expect(fakes.dossier.build).toHaveBeenCalledWith('user-1', 'e-1');
      expect(result.facts.active.map((f) => f.id)).toEqual(['f-ok']);
      expect(result.commitments.owedByMe.map((c) => c.id)).toEqual(['c-ok']);
      expect(result.commitments.owedToMe).toEqual([]);
      expect(result.openQuestions).toEqual([]);
      expect(result.recentItems.map((r) => r.inboxItemId)).toEqual(['ok']);
      // The neighbor is backed only by a secret item ⇒ relation + neighbor dropped.
      expect(result.relations).toEqual([]);
      expect(result.neighbors).toEqual([]);
      expect(result.counts).toMatchObject({ activeFacts: 1, owedByMe: 1, owedToMe: 0, mentions: 1 });
    });
  });

  describe('single-source open loops (sensitivity gate)', () => {
    it('list_commitments keeps only rows on a classified, non-local-only item', async () => {
      const { service, fakes } = build();
      fakes.commitments.list.mockResolvedValue({
        commitments: [
          { id: 'c-ok', inboxItemId: 'ok' },
          { id: 'c-secret', inboxItemId: 'secret' },
          { id: 'c-new', inboxItemId: 'new' },
        ],
        needsOwner: false,
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.listCommitments('user-1', { limit: 20 });
      expect(fakes.commitments.list).toHaveBeenCalledWith('user-1', {
        direction: undefined,
        status: undefined,
      });
      expect(result.commitments.map((c) => c.id)).toEqual(['c-ok']);
    });

    it('list_tasks gates by citation item and pages the gated list', async () => {
      const { service, fakes } = build();
      fakes.tasks.list.mockResolvedValue([
        { id: 't-ok', title: 'A' },
        { id: 't-secret', title: 'B' },
      ]);
      fakes.tasks.citationItemIds.mockResolvedValue(
        new Map([
          ['t-ok', ['ok']],
          ['t-secret', ['secret']],
        ]),
      );
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.listTasks('user-1', { limit: 20 });
      expect(fakes.tasks.list).toHaveBeenCalledWith('user-1', undefined);
      expect(result.tasks.map((t) => t.id)).toEqual(['t-ok']);
    });
  });

  describe('getJournal (sensitivity gate)', () => {
    it('withholds the body when any direct item citation is sensitive', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal.mockResolvedValue({
        periodType: 'day',
        periodKey: '2026-07-01',
        markdown: 'secret narrative',
        citations: [
          { marker: 1, kind: 'item', refId: 'ok' },
          { marker: 2, kind: 'item', refId: 'secret' },
          { marker: 3, kind: 'journal', refId: '2026-06-30' },
        ],
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.getJournal('user-1', {
        periodType: 'day',
        periodKey: '2026-07-01',
      });
      expect(result.redacted).toBe(true);
      expect(result.markdown).toBeNull();
      // The sensitive item citation is dropped; the journal-kind citation stays.
      expect(result.citations.map((c) => c.refId)).toEqual(['ok', '2026-06-30']);
    });

    it('returns the body when all direct item citations are allowed', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal.mockResolvedValue({
        periodType: 'day',
        periodKey: '2026-07-01',
        markdown: 'fine narrative',
        citations: [{ marker: 1, kind: 'item', refId: 'ok' }],
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal' });

      const result = await service.getJournal('user-1', {
        periodType: 'day',
        periodKey: '2026-07-01',
      });
      expect(result.redacted).toBe(false);
      expect(result.markdown).toBe('fine narrative');
    });
  });

  describe('listCalendarEvents (sensitivity gate)', () => {
    it('strips sensitive/unclassified recordings from linkedRecordingIds but keeps events', async () => {
      const { service, fakes } = build();
      fakes.calendar.eventsInRange.mockResolvedValue([
        { id: 'ev-1', title: 'Sync', linkedRecordingIds: ['ok', 'secret', 'new'] },
      ]);
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.listCalendarEvents('user-1', {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z',
      });
      expect(fakes.calendar.eventsInRange).toHaveBeenCalledWith(
        'user-1',
        '2026-07-01T00:00:00.000Z',
        '2026-07-02T00:00:00.000Z',
      );
      expect(result.events[0].linkedRecordingIds).toEqual(['ok']);
    });
  });
});
