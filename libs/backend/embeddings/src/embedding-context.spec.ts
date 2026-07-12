import type { ExtractionSegment } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { buildEmbeddableChunks } from './embedding-context';

function row(
  kind: ExtractedPayloadEntity['kind'],
  status: ExtractedPayloadEntity['status'],
  createdAt: string,
  content: string | null,
  extra: Partial<ExtractedPayloadEntity> = {},
): ExtractedPayloadEntity {
  return {
    kind,
    status,
    createdAt: new Date(createdAt),
    content,
    language: null,
    segments: null,
    ...extra,
  } as ExtractedPayloadEntity;
}

function item(extractions: ExtractedPayloadEntity[]): InboxItemEntity {
  return { id: 'item-1', userId: 'user-1', extractions } as InboxItemEntity;
}

describe('buildEmbeddableChunks (JJ-83 OCR source)', () => {
  it('audio path unchanged: transcript chunks keep segment timestamps', () => {
    const segments: ExtractionSegment[] = [
      { start: 0, end: 8, text: 'hello there' },
      { start: 8, end: 16, text: 'general note' },
    ];
    const ctx = buildEmbeddableChunks(
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z', 'hello there general note', {
          segments,
        }),
      ]),
    );
    expect(ctx.transcriptChunks).toBeGreaterThan(0);
    expect(ctx.chunks.every((c) => c.source === 'transcript')).toBe(true);
    expect(ctx.chunks[0].startSeconds).toBe(0);
    expect(ctx.chunks[ctx.chunks.length - 1].endSeconds).toBe(16);
  });

  it('embeds OCR text as timeless transcript chunks when there is no transcription', () => {
    const ctx = buildEmbeddableChunks(
      item([
        row(
          'ocr',
          'succeeded',
          '2026-07-01T10:00:00Z',
          'Invoice from ACME GmbH. Total 42 EUR. Due 2026-08-01.',
        ),
      ]),
    );
    expect(ctx.transcriptChunks).toBeGreaterThan(0);
    expect(ctx.chunks.length).toBe(ctx.transcriptChunks);
    for (const chunk of ctx.chunks) {
      expect(chunk.source).toBe('transcript');
      // A scan has no timeline — chunks are timeless.
      expect(chunk.startSeconds).toBeNull();
      expect(chunk.endSeconds).toBeNull();
      expect(chunk.text).toContain('ACME');
    }
  });

  it('produces no chunks for an item with neither transcription nor OCR', () => {
    const ctx = buildEmbeddableChunks(item([]));
    expect(ctx.chunks).toHaveLength(0);
    expect(ctx.transcriptChunks).toBe(0);
    expect(ctx.summaryChunks).toBe(0);
  });
});
