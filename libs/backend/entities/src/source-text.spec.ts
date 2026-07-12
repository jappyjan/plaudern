// The `resolveSourceText`/`hasSucceededSourceExtraction` helpers live in
// @plaudern/inbox (a dependency-only lib with no test target of its own); they
// are exercised here in the entities lib — their flagship consumer — so the
// transcription→OCR resolution contract has direct coverage.
import { hasSucceededSourceExtraction, resolveSourceText } from '@plaudern/inbox';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';

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
  return { id: 'item-1', userId: 'user-1', extractions } as InboxItemEntity;
}

describe('resolveSourceText (JJ-83 transcription→OCR fallback)', () => {
  it('returns the latest succeeded transcription when present', () => {
    const resolved = resolveSourceText(
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z', 'spoken words', 'en')]),
    );
    expect(resolved).toEqual({
      text: 'spoken words',
      language: 'en',
      kind: 'transcription',
      extraction: expect.objectContaining({ kind: 'transcription' }),
    });
  });

  it('falls back to the latest succeeded OCR text for a scanned document (no transcription)', () => {
    const resolved = resolveSourceText(
      item([row('ocr', 'succeeded', '2026-07-01T10:00:00Z', 'invoice total 42 EUR', 'de')]),
    );
    expect(resolved?.kind).toBe('ocr');
    expect(resolved?.text).toBe('invoice total 42 EUR');
    expect(resolved?.language).toBe('de');
  });

  it('prefers the transcription over OCR when both succeeded (passthrough-friendly)', () => {
    const resolved = resolveSourceText(
      item([
        row('ocr', 'succeeded', '2026-07-01T10:00:00Z', 'ocr text'),
        row('transcription', 'succeeded', '2026-07-01T10:01:00Z', 'transcript text'),
      ]),
    );
    expect(resolved?.kind).toBe('transcription');
    expect(resolved?.text).toBe('transcript text');
  });

  it('ignores a failed or empty OCR row', () => {
    expect(resolveSourceText(item([row('ocr', 'failed', '2026-07-01T10:00:00Z', null)]))).toBeNull();
    // A blank scan: OCR succeeded but produced no text — nothing to run on.
    expect(resolveSourceText(item([row('ocr', 'succeeded', '2026-07-01T10:00:00Z', '')]))).toBeNull();
  });

  it('uses only the latest OCR attempt (append-only history)', () => {
    const resolved = resolveSourceText(
      item([
        row('ocr', 'succeeded', '2026-07-01T10:00:00Z', 'old scan'),
        row('ocr', 'succeeded', '2026-07-01T11:00:00Z', 'new scan'),
      ]),
    );
    expect(resolved?.text).toBe('new scan');
  });

  it('returns null when there is neither a transcription nor an OCR row', () => {
    expect(resolveSourceText(item([]))).toBeNull();
  });
});

describe('hasSucceededSourceExtraction (retry guard — status only)', () => {
  it('accepts a succeeded transcription even without content (fixture-friendly)', () => {
    expect(
      hasSucceededSourceExtraction(item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z', null)])),
    ).toBe(true);
  });

  it('accepts a succeeded OCR row (scanned document)', () => {
    expect(
      hasSucceededSourceExtraction(item([row('ocr', 'succeeded', '2026-07-01T10:00:00Z', 'x')])),
    ).toBe(true);
  });

  it('rejects when neither source has a succeeded row', () => {
    expect(
      hasSucceededSourceExtraction(item([row('ocr', 'failed', '2026-07-01T10:00:00Z', null)])),
    ).toBe(false);
    expect(hasSucceededSourceExtraction(item([]))).toBe(false);
  });
});
