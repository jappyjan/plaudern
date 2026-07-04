import type { ExtractionSegment } from '@plaudern/contracts';
import { chunkPlainText, chunkTranscript } from './embedding.chunker';

describe('chunkTranscript', () => {
  it('coalesces small consecutive segments into one timestamped chunk', () => {
    const segments: ExtractionSegment[] = [
      { start: 0, end: 8, text: 'hello there' },
      { start: 8, end: 16, text: 'general kenobi' },
    ];
    const chunks = chunkTranscript('hello there general kenobi', segments, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      text: 'hello there general kenobi',
      startSeconds: 0,
      endSeconds: 16,
    });
  });

  it('splits into multiple chunks when segments exceed the char budget, keeping timing', () => {
    const segments: ExtractionSegment[] = [
      { start: 0, end: 5, text: 'aaaa' },
      { start: 5, end: 10, text: 'bbbb' },
      { start: 10, end: 15, text: 'cccc' },
    ];
    // Budget fits ~one segment per chunk (4 chars each).
    const chunks = chunkTranscript('aaaa bbbb cccc', segments, 5);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => [c.startSeconds, c.endSeconds])).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
    expect(chunks[1].text).toBe('bbbb');
  });

  it('never splits a single segment even if it exceeds the budget', () => {
    const segments: ExtractionSegment[] = [{ start: 0, end: 3, text: 'a very long single segment' }];
    const chunks = chunkTranscript('a very long single segment', segments, 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('a very long single segment');
    expect(chunks[0].startSeconds).toBe(0);
  });

  it('falls back to plain-text chunking with null timestamps when there are no segments', () => {
    const chunks = chunkTranscript('just some flat text', null, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startSeconds).toBeNull();
    expect(chunks[0].endSeconds).toBeNull();
    expect(chunks[0].text).toBe('just some flat text');
  });

  it('ignores empty/whitespace-only segments', () => {
    const segments: ExtractionSegment[] = [
      { start: 0, end: 5, text: '   ' },
      { start: 5, end: 10, text: 'real' },
    ];
    const chunks = chunkTranscript('real', segments, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text: 'real', startSeconds: 5, endSeconds: 10 });
  });
});

describe('chunkPlainText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkPlainText('   ')).toEqual([]);
  });

  it('keeps short prose as a single chunk', () => {
    expect(chunkPlainText('a short summary')).toEqual(['a short summary']);
  });

  it('packs paragraphs together up to the budget', () => {
    const text = 'para one\n\npara two\n\npara three';
    const chunks = chunkPlainText(text, 20);
    // "para one\n\npara two" = 18 chars fits; "para three" starts a new chunk.
    expect(chunks).toEqual(['para one\n\npara two', 'para three']);
  });

  it('hard-splits a paragraph longer than the budget on whitespace', () => {
    const chunks = chunkPlainText('alpha beta gamma delta', 11);
    expect(chunks.every((c) => c.length <= 11)).toBe(true);
    expect(chunks.join(' ')).toBe('alpha beta gamma delta');
  });
});
