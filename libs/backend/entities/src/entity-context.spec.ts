import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { buildEntityExtractionInput } from './entity-context';

function row(
  kind: ExtractedPayloadEntity['kind'],
  status: ExtractedPayloadEntity['status'],
  createdAt: string,
  content: string | null,
  language: string | null = null,
): ExtractedPayloadEntity {
  return { kind, status, createdAt: new Date(createdAt), content, language } as ExtractedPayloadEntity;
}

function item(extractions: ExtractedPayloadEntity[]): InboxItemEntity {
  return {
    id: 'item-1',
    userId: 'user-1',
    occurredAt: new Date('2026-07-01T09:30:00Z'),
    extractions,
  } as unknown as InboxItemEntity;
}

describe('buildEntityExtractionInput (JJ-83 OCR source)', () => {
  it('extracts entities from a transcription (audio path, unchanged)', () => {
    const input = buildEntityExtractionInput(
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z', 'Alice met Bob', 'en')]),
    );
    expect(input).toEqual({
      text: 'Alice met Bob',
      language: 'en',
      occurredAt: '2026-07-01T09:30:00.000Z',
    });
  });

  it('extracts entities from OCR text when there is no transcription (scanned document)', () => {
    const input = buildEntityExtractionInput(
      item([row('ocr', 'succeeded', '2026-07-01T10:00:00Z', 'Invoice from ACME GmbH', 'de')]),
    );
    expect(input).toEqual({
      text: 'Invoice from ACME GmbH',
      language: 'de',
      occurredAt: '2026-07-01T09:30:00.000Z',
    });
  });

  it('returns null when the item has no source text', () => {
    expect(buildEntityExtractionInput(item([]))).toBeNull();
    expect(
      buildEntityExtractionInput(item([row('ocr', 'failed', '2026-07-01T10:00:00Z', null)])),
    ).toBeNull();
  });
});
