import type { ExtractionSegment } from '@plaudern/contracts';

/** Target maximum characters per chunk. Chunks stay whole words/segments. */
export const DEFAULT_MAX_CHARS = 1000;

export interface TranscriptChunk {
  text: string;
  /** Start of the first covered segment; null when there are no timestamps. */
  startSeconds: number | null;
  /** End of the last covered segment; null when there are no timestamps. */
  endSeconds: number | null;
}

/**
 * Chunk a transcript into embeddable windows that keep their audio timestamps
 * so a retrieval hit can deep-link into the recording. Consecutive timed
 * segments are coalesced up to `maxChars` (never splitting a segment), and the
 * chunk inherits the first segment's start and the last segment's end.
 *
 * When there are no usable timed segments (e.g. a provider that returns only
 * flat text) it falls back to plain-text chunking with null timestamps, so the
 * content is still embedded — just without deep-linking.
 */
export function chunkTranscript(
  content: string,
  segments: ExtractionSegment[] | null,
  maxChars: number = DEFAULT_MAX_CHARS,
): TranscriptChunk[] {
  const timed = (segments ?? []).filter((s) => (s.text ?? '').trim().length > 0);
  if (timed.length === 0) {
    return chunkPlainText(content, maxChars).map((text) => ({
      text,
      startSeconds: null,
      endSeconds: null,
    }));
  }

  const chunks: TranscriptChunk[] = [];
  let current: { texts: string[]; start: number; end: number } | null = null;

  for (const seg of timed) {
    const text = (seg.text ?? '').trim();
    if (!current) {
      current = { texts: [text], start: seg.start, end: seg.end };
      continue;
    }
    const projected = current.texts.join(' ').length + 1 + text.length;
    if (projected > maxChars) {
      chunks.push({
        text: current.texts.join(' '),
        startSeconds: current.start,
        endSeconds: current.end,
      });
      current = { texts: [text], start: seg.start, end: seg.end };
    } else {
      current.texts.push(text);
      current.end = seg.end;
    }
  }
  if (current) {
    chunks.push({
      text: current.texts.join(' '),
      startSeconds: current.start,
      endSeconds: current.end,
    });
  }
  return chunks;
}

/**
 * Chunk timeless prose (e.g. an AI summary) into windows up to `maxChars`.
 * Splits on blank-line paragraph boundaries first, packing whole paragraphs
 * together; a paragraph longer than `maxChars` is hard-split on whitespace so a
 * single chunk never exceeds the budget by more than one word.
 */
export function chunkPlainText(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    for (const piece of paragraph.length > maxChars ? hardSplit(paragraph, maxChars) : [paragraph]) {
      if (!current) {
        current = piece;
      } else if (current.length + 2 + piece.length <= maxChars) {
        current = `${current}\n\n${piece}`;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return chunks;
}

/** Split an over-long paragraph on whitespace into <= maxChars pieces. */
function hardSplit(paragraph: string, maxChars: number): string[] {
  const words = paragraph.split(/\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
