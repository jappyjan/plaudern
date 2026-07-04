import { NotFoundException } from '@nestjs/common';
import type { InboxItemEntity } from '@plaudern/persistence';
import type { EmbeddingSearchHit } from '@plaudern/embeddings';
import { McpToolsService } from './mcp.tools';

type Fakes = {
  inbox: { getItem: jest.Mock; listItems: jest.Mock };
  search: { search: jest.Mock };
  ingestion: { ingestText: jest.Mock };
};

function build(): { service: McpToolsService; fakes: Fakes } {
  const fakes: Fakes = {
    inbox: { getItem: jest.fn(), listItems: jest.fn() },
    search: { search: jest.fn() },
    ingestion: { ingestText: jest.fn() },
  };
  const service = new McpToolsService(
    fakes.inbox as never,
    fakes.search as never,
    fakes.ingestion as never,
  );
  return { service, fakes };
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
    it('maps search hits to snippets with rounded scores and item refs', async () => {
      const { service, fakes } = build();
      const hits: EmbeddingSearchHit[] = [
        {
          inboxItemId: 'item-9',
          chunkId: 'chunk-9',
          source: 'transcript',
          text: 'we agreed to launch on Friday',
          startSeconds: 12.5,
          endSeconds: 20,
          score: 0.876543,
        },
      ];
      fakes.search.search.mockResolvedValue(hits);

      const result = await service.searchMemory('user-1', { query: 'launch date', limit: 5 });

      expect(fakes.search.search).toHaveBeenCalledWith('user-1', 'launch date', 5);
      expect(result).toEqual([
        {
          itemId: 'item-9',
          source: 'transcript',
          snippet: 'we agreed to launch on Friday',
          score: 0.877,
          startSeconds: 12.5,
          endSeconds: 20,
        },
      ]);
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
});
