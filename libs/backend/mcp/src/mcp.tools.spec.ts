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
  entityGraph: { edgesFor: jest.Mock; edgeEvidenceItemIds: jest.Mock };
  dossier: { build: jest.Mock };
  facts: { listWithCitations: jest.Mock };
  tasks: {
    list: jest.Mock;
    citationItemIds: jest.Mock;
    listForMcp: jest.Mock;
    createUserTask: jest.Mock;
    findForMcpMutation: jest.Mock;
    setStatusIfUnchanged: jest.Mock;
  };
  commitments: { list: jest.Mock; findForStatusUpdate: jest.Mock; setStatusIfUnchanged: jest.Mock };
  questions: { list: jest.Mock; findForStatusUpdate: jest.Mock; setStatusIfUnchanged: jest.Mock };
  decisions: { list: jest.Mock };
  reminders: { list: jest.Mock };
  topics: { listTopics: jest.Mock; listItemsByTopic: jest.Mock };
  journal: { listPeriods: jest.Mock; getJournal: jest.Mock };
  calendar: { eventsInRange: jest.Mock };
  audit: { recordMcpMutation: jest.Mock };
};

function build(): { service: McpToolsService; fakes: Fakes } {
  const fakes: Fakes = {
    inbox: { getItem: jest.fn(), listItems: jest.fn() },
    search: { search: jest.fn() },
    ingestion: { ingestText: jest.fn() },
    // JJ-78 knowledge-graph read deps + the JJ-21 sensitivity gate.
    sensitivity: { effectiveTiers: jest.fn().mockResolvedValue(new Map()) },
    entitiesRegistry: { list: jest.fn(), mentionItemIds: jest.fn() },
    entityGraph: {
      edgesFor: jest.fn().mockResolvedValue([]),
      edgeEvidenceItemIds: jest.fn().mockResolvedValue(new Map()),
    },
    dossier: { build: jest.fn() },
    facts: { listWithCitations: jest.fn() },
    tasks: {
      list: jest.fn(),
      citationItemIds: jest.fn(),
      listForMcp: jest.fn(),
      createUserTask: jest.fn(),
      findForMcpMutation: jest.fn(),
      setStatusIfUnchanged: jest.fn(),
    },
    commitments: {
      list: jest.fn(),
      findForStatusUpdate: jest.fn(),
      setStatusIfUnchanged: jest.fn(),
    },
    questions: {
      list: jest.fn(),
      findForStatusUpdate: jest.fn(),
      setStatusIfUnchanged: jest.fn(),
    },
    decisions: { list: jest.fn() },
    reminders: { list: jest.fn() },
    topics: { listTopics: jest.fn(), listItemsByTopic: jest.fn() },
    journal: { listPeriods: jest.fn(), getJournal: jest.fn() },
    calendar: { eventsInRange: jest.fn() },
    audit: { recordMcpMutation: jest.fn().mockResolvedValue(undefined) },
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
    fakes.audit as never,
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
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-1': 'normal' });

      const result = await service.getItem('user-1', { itemId: 'item-1' });

      expect(fakes.inbox.getItem).toHaveBeenCalledWith('user-1', 'item-1');
      expect(result.redacted).toBe(false);
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
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-1': 'normal' });

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
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-1': 'normal' });

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

    // JJ-86: get_item must not return sensitive/secret or not-yet-classified
    // content by fetching a known id directly (the leak this closes).
    it.each(['secret', null] as const)(
      'WITHHOLDS content when the item tier is %s (fail closed)',
      async (tier) => {
        const { service, fakes } = build();
        fakes.inbox.getItem.mockResolvedValue(
          item({
            id: 'item-1',
            metadata: { location: 'Berlin' },
            extractions: [
              extraction({ kind: 'transcription', content: 'the password is hunter2' }),
              extraction({ kind: 'summary', content: summaryContent() }),
            ] as never,
          }),
        );
        fakes.sensitivity.effectiveTiers = tier
          ? tierMap({ 'item-1': tier })
          : jest.fn().mockResolvedValue(new Map());

        const result = await service.getItem('user-1', { itemId: 'item-1' });
        expect(result.redacted).toBe(true);
        expect(result.transcript).toBeNull();
        expect(result.summary).toBeNull();
        expect(result.metadata).toBeNull();
        expect(result.title).toBeNull();
        // Non-content envelope is still returned so the tool call is coherent.
        expect(result.itemId).toBe('item-1');
      },
    );
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
      fakes.sensitivity.effectiveTiers = tierMap({ 'item-1': 'normal', 'item-2': 'public' });

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

    // JJ-86: sensitive/secret and not-yet-classified items must NOT be
    // enumerated — otherwise an external model walks their ids and then reads
    // them (get_item), bypassing the search-retrieval tier filter.
    it('does not enumerate sensitive/secret or unclassified items (fail closed)', async () => {
      const { service, fakes } = build();
      fakes.inbox.listItems.mockResolvedValue({
        items: [
          item({ id: 'ok', extractions: [] }),
          item({ id: 'secret', extractions: [] }),
          item({ id: 'sensitive', extractions: [] }),
          item({ id: 'unclassified', extractions: [] }),
        ],
        nextCursor: '4',
      });
      fakes.sensitivity.effectiveTiers = tierMap({
        ok: 'normal',
        secret: 'secret',
        sensitive: 'sensitive',
        // 'unclassified' intentionally absent → null tier → excluded.
      });

      const result = await service.listRecentItems('user-1', { limit: 20 });
      expect(result.items.map((i) => i.itemId)).toEqual(['ok']);
      // Pagination still advances even though the page was mostly filtered.
      expect(result.nextCursor).toBe('4');
    });
  });

  describe('ingestTextNote', () => {
    const actor = { userId: 'user-1', tokenPrefix: 'mcp_ab12' };

    it('captures a note via the ingestion text path, returns its id, and audits it', async () => {
      const { service, fakes } = build();
      fakes.ingestion.ingestText.mockResolvedValue({ id: 'note-1' });

      const result = await service.ingestTextNote(actor, { text: 'remember the milk' });

      expect(result).toEqual({ itemId: 'note-1' });
      const [userId, req] = fakes.ingestion.ingestText.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(req.text).toBe('remember the milk');
      expect(typeof req.occurredAt).toBe('string');
      expect(req.idempotencyKey).toMatch(/^mcp-note-/);
      expect(req.metadata).toBeUndefined();
      expect(fakes.audit.recordMcpMutation).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'ingest_text_note', itemId: 'note-1' }),
      );
    });

    it('honors a caller-supplied occurredAt, idempotencyKey and title', async () => {
      const { service, fakes } = build();
      fakes.ingestion.ingestText.mockResolvedValue({ id: 'note-2' });

      await service.ingestTextNote(actor, {
        text: 'pinned',
        occurredAt: '2026-01-02T03:04:05.000Z',
        idempotencyKey: 'fixed-key',
        title: 'Groceries',
      });

      const [, req] = fakes.ingestion.ingestText.mock.calls[0];
      expect(req.occurredAt).toBe('2026-01-02T03:04:05.000Z');
      expect(req.idempotencyKey).toBe('fixed-key');
      // Title reuses the metadata.tags.title slot the read tools surface.
      expect(req.metadata).toEqual({ tags: { title: 'Groceries' } });
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

    it('list_tasks gates cited tasks by source item, surfaces citation-less user tasks, hides ghosts', async () => {
      const { service, fakes } = build();
      fakes.tasks.listForMcp.mockResolvedValue([
        // Cited by an allowed item — shown.
        { task: { id: 't-ok', title: 'A' }, citationItemIds: ['ok'], hasCitations: true },
        // Cited only by a sensitive item — hidden (fail closed).
        { task: { id: 't-secret', title: 'B' }, citationItemIds: ['secret'], hasCitations: true },
        // Citation-less user-created task — shown (no item-derived content to gate).
        { task: { id: 't-user', title: 'C' }, citationItemIds: [], hasCitations: false },
        // Ghost: had citations but none current/allowed — hidden.
        { task: { id: 't-ghost', title: 'D' }, citationItemIds: [], hasCitations: true },
      ]);
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.listTasks('user-1', { limit: 20 });
      expect(fakes.tasks.listForMcp).toHaveBeenCalledWith('user-1', undefined);
      expect(result.tasks.map((t) => t.id)).toEqual(['t-ok', 't-user']);
    });
  });

  describe('mutation tools', () => {
    const actor = { userId: 'user-1', tokenPrefix: 'mcp_ab12' };

    it('create_task delegates to the registry and audits the write', async () => {
      const { service, fakes } = build();
      fakes.tasks.createUserTask.mockResolvedValue({ id: 'task-9', title: 'Ship it', dueDate: null });

      const result = await service.createTask(actor, { title: 'Ship it' });
      expect(fakes.tasks.createUserTask).toHaveBeenCalledWith('user-1', {
        title: 'Ship it',
        dueDate: null,
      });
      expect(result.id).toBe('task-9');
      expect(fakes.audit.recordMcpMutation).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'create_task', tokenPrefix: 'mcp_ab12', userId: 'user-1' }),
      );
    });

    it('update_task_status flips a citation-less task race-safely and audits it', async () => {
      const { service, fakes } = build();
      fakes.tasks.findForMcpMutation.mockResolvedValue({
        status: 'open',
        citationItemIds: [],
        hasCitations: false,
      });
      fakes.tasks.setStatusIfUnchanged.mockResolvedValue({ id: 'task-9', status: 'completed' });

      const result = await service.updateTaskStatus(actor, { taskId: 'task-9', status: 'completed' });
      // Conditional flip is invoked with the CURRENT status as the expected guard.
      expect(fakes.tasks.setStatusIfUnchanged).toHaveBeenCalledWith(
        'user-1',
        'task-9',
        'open',
        'completed',
      );
      expect(result.status).toBe('completed');
      expect(fakes.audit.recordMcpMutation).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'update_task_status', change: expect.objectContaining({ from: 'open', to: 'completed' }) }),
      );
    });

    it('update_task_status refuses a task whose only source items are gated (fail closed)', async () => {
      const { service, fakes } = build();
      fakes.tasks.findForMcpMutation.mockResolvedValue({
        status: 'open',
        citationItemIds: ['secret'],
        hasCitations: true,
      });
      fakes.sensitivity.effectiveTiers = tierMap({ secret: 'secret' });

      await expect(
        service.updateTaskStatus(actor, { taskId: 'task-9', status: 'completed' }),
      ).rejects.toThrow('task not found');
      expect(fakes.tasks.setStatusIfUnchanged).not.toHaveBeenCalled();
    });

    it('update_commitment_status refuses when the source item is not yet classified (fail closed)', async () => {
      const { service, fakes } = build();
      fakes.commitments.findForStatusUpdate.mockResolvedValue({
        status: 'open',
        inboxItemId: 'unclassified',
      });
      // No tier for the item ⇒ excluded ⇒ mutation refused.
      fakes.sensitivity.effectiveTiers = tierMap({});

      await expect(
        service.updateCommitmentStatus(actor, { commitmentId: 'c-1', status: 'fulfilled' }),
      ).rejects.toThrow('commitment not found');
      expect(fakes.commitments.setStatusIfUnchanged).not.toHaveBeenCalled();
    });

    it('update_commitment_status flips race-safely for an allowed item and audits it', async () => {
      const { service, fakes } = build();
      fakes.commitments.findForStatusUpdate.mockResolvedValue({
        status: 'open',
        inboxItemId: 'ok',
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal' });
      fakes.commitments.setStatusIfUnchanged.mockResolvedValue({ id: 'c-1', status: 'fulfilled' });

      const result = await service.updateCommitmentStatus(actor, {
        commitmentId: 'c-1',
        status: 'fulfilled',
      });
      expect(fakes.commitments.setStatusIfUnchanged).toHaveBeenCalledWith(
        'user-1',
        'c-1',
        'open',
        'fulfilled',
      );
      expect(result.status).toBe('fulfilled');
      expect(fakes.audit.recordMcpMutation).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'update_commitment_status', itemId: 'ok' }),
      );
    });

    it('answer_question marks answered for an allowed item and records the answer in the audit', async () => {
      const { service, fakes } = build();
      fakes.questions.findForStatusUpdate.mockResolvedValue({
        status: 'open',
        inboxItemId: 'ok',
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal' });
      fakes.questions.setStatusIfUnchanged.mockResolvedValue({ id: 'q-1', status: 'answered' });

      const result = await service.answerQuestion(actor, { questionId: 'q-1', answer: 'yes, at 3pm' });
      expect(fakes.questions.setStatusIfUnchanged).toHaveBeenCalledWith(
        'user-1',
        'q-1',
        'open',
        'answered',
      );
      expect(result.status).toBe('answered');
      expect(fakes.audit.recordMcpMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'answer_question',
          change: expect.objectContaining({ answer: 'yes, at 3pm', to: 'answered' }),
        }),
      );
    });

    it('answer_question refuses an unknown id', async () => {
      const { service, fakes } = build();
      fakes.questions.findForStatusUpdate.mockResolvedValue(null);
      await expect(
        service.answerQuestion(actor, { questionId: 'nope', answer: 'x' }),
      ).rejects.toThrow('question not found');
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

  describe('getJournal rollups (transitive sensitivity gate)', () => {
    /** A journal.getJournal fake that dispatches on (periodType, periodKey). */
    function journalDocs(
      docs: Record<string, { version: number | null; markdown: string | null; citations: unknown[] }>,
    ): jest.Mock {
      return jest.fn(async (_uid: string, periodType: string, periodKey: string) => {
        const doc = docs[`${periodType}:${periodKey}`];
        return {
          periodType,
          periodKey,
          version: doc?.version ?? null,
          markdown: doc?.markdown ?? null,
          citations: doc?.citations ?? [],
        };
      });
    }

    it('withholds a WEEK body when a transitive child-day item is sensitive', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal = journalDocs({
        'week:2026-W26': {
          version: 1,
          markdown: 'week narrative summarizing both days',
          citations: [
            { marker: 1, kind: 'journal', refId: '2026-06-29' },
            { marker: 2, kind: 'journal', refId: '2026-06-30' },
          ],
        },
        'day:2026-06-29': { version: 1, markdown: 'ok day', citations: [{ kind: 'item', refId: 'ok' }] },
        'day:2026-06-30': {
          version: 1,
          markdown: 'secret day',
          citations: [{ kind: 'item', refId: 'secret' }],
        },
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', secret: 'secret' });

      const result = await service.getJournal('user-1', { periodType: 'week', periodKey: '2026-W26' });
      // The rollup has NO kind:'item' citations of its own, but it transitively
      // summarizes a secret day → body must be withheld, not leaked.
      expect(result.redacted).toBe(true);
      expect(result.markdown).toBeNull();
    });

    it('returns a WEEK body when every transitive child-day item is allowed', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal = journalDocs({
        'week:2026-W26': {
          version: 1,
          markdown: 'clean week narrative [1]',
          citations: [{ marker: 1, kind: 'journal', refId: '2026-06-29' }],
        },
        'day:2026-06-29': { version: 1, markdown: 'ok day', citations: [{ kind: 'item', refId: 'ok' }] },
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal' });

      const result = await service.getJournal('user-1', { periodType: 'week', periodKey: '2026-W26' });
      expect(result.redacted).toBe(false);
      expect(result.markdown).toBe('clean week narrative [1]');
    });

    // JJ-86 under-citation fold-in: get_journal tier-gates via citation
    // completeness, so a body it CAN'T trace must be withheld even when every
    // (resolvable) citation is allowed.
    it('withholds a body that has prose but ZERO item/journal citations', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal = journalDocs({
        'day:2026-07-02': {
          version: 1,
          markdown: 'A vivid narrative of the day with no citation markers at all.',
          citations: [], // nothing to tier-gate against → unverifiable
        },
      });
      fakes.sensitivity.effectiveTiers = tierMap({});

      const result = await service.getJournal('user-1', { periodType: 'day', periodKey: '2026-07-02' });
      expect(result.redacted).toBe(true);
      expect(result.markdown).toBeNull();
    });

    it('withholds a body whose citation-coverage confidence is low (uncited claims)', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal = journalDocs({
        'day:2026-07-03': {
          version: 1,
          // Two substantive claims, only one cited → coverage 0.5 ≤ threshold → low.
          markdown: 'We closed the Q3 deal for two million euros. The team celebrated late [1].',
          citations: [{ marker: 1, kind: 'item', refId: 'ok' }],
        },
      });
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal' });

      const result = await service.getJournal('user-1', { periodType: 'day', periodKey: '2026-07-03' });
      expect(result.redacted).toBe(true);
      expect(result.markdown).toBeNull();
    });

    it('fails closed when a child journal has no current succeeded version', async () => {
      const { service, fakes } = build();
      fakes.journal.getJournal = journalDocs({
        'month:2026-06': {
          version: 1,
          markdown: 'month narrative',
          citations: [{ marker: 1, kind: 'journal', refId: '2026-06-15' }],
        },
        // child day resolves to no succeeded version (version null) — unre-derivable.
        'day:2026-06-15': { version: null, markdown: null, citations: [] },
      });
      fakes.sensitivity.effectiveTiers = tierMap({});

      const result = await service.getJournal('user-1', { periodType: 'month', periodKey: '2026-06' });
      expect(result.redacted).toBe(true);
      expect(result.markdown).toBeNull();
    });
  });

  describe('listRelations (edge-evidence sensitivity gate)', () => {
    function edge(over: Partial<Record<string, unknown>> = {}) {
      return {
        sourceEntityId: (over.sourceEntityId as string) ?? 'e-1',
        targetEntityId: (over.targetEntityId as string) ?? 'n-1',
        relationType: (over.relationType as string) ?? 'related_to',
        label: (over.label as string | null) ?? 'spouse',
        confidence: 0.9,
        origin: 'llm',
        evidenceCount: (over.evidenceCount as number) ?? 3,
        firstSeenAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-01T00:00:00.000Z',
      };
    }
    function mentions(src: Record<string, string[]>): jest.Mock {
      return jest.fn(async (_u: string, ids: string[]) => {
        const m = new Map<string, string[]>();
        for (const id of ids) m.set(id, src[id] ?? []);
        return m;
      });
    }

    it('drops an edge whose only evidence is a secret item, even when both endpoints are visible', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.mentionItemIds = mentions({ 'e-1': ['ok'], 'n-1': ['ok2'] });
      fakes.entityGraph.edgesFor.mockResolvedValue([edge()]);
      // The A–B edge was asserted SOLELY from a secret recording.
      fakes.entityGraph.edgeEvidenceItemIds.mockResolvedValue(
        new Map([['e-1:n-1:related_to', ['secret']]]),
      );
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', ok2: 'normal', secret: 'secret' });

      const result = await service.listRelations('user-1', { entityId: 'e-1', limit: 20 });
      expect(result.relations).toEqual([]);
    });

    it('keeps an edge with mixed evidence and recomputes evidenceCount from allowed items', async () => {
      const { service, fakes } = build();
      fakes.entitiesRegistry.mentionItemIds = mentions({ 'e-1': ['ok'], 'n-1': ['ok2'] });
      fakes.entityGraph.edgesFor.mockResolvedValue([edge({ evidenceCount: 3 })]);
      fakes.entityGraph.edgeEvidenceItemIds.mockResolvedValue(
        new Map([['e-1:n-1:related_to', ['ok', 'secret', 'new']]]),
      );
      fakes.entitiesRegistry.list.mockResolvedValue([
        { id: 'n-1', canonicalName: 'Neighbor', type: 'person', aliases: [] },
      ]);
      fakes.sensitivity.effectiveTiers = tierMap({ ok: 'normal', ok2: 'normal', secret: 'secret' });

      const result = await service.listRelations('user-1', { entityId: 'e-1', limit: 20 });
      expect(result.relations).toHaveLength(1);
      // 3 raw evidence items but only 'ok' is allowed ⇒ recomputed to 1.
      expect(result.relations[0].evidenceCount).toBe(1);
      expect(result.neighbors).toEqual([{ id: 'n-1', canonicalName: 'Neighbor', type: 'person' }]);
    });
  });
});
