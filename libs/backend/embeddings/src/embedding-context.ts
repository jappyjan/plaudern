import { summaryPayloadSchema, type EmbeddingChunkSource } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { chunkPlainText, chunkTranscript, DEFAULT_MAX_CHARS } from './embedding.chunker';

/** One unit to embed: its text, source, running index and (transcript) timing. */
export interface EmbeddableChunk {
  source: EmbeddingChunkSource;
  chunkIndex: number;
  text: string;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface EmbeddingContext {
  chunks: EmbeddableChunk[];
  transcriptChunks: number;
  summaryChunks: number;
}

/**
 * Assemble the embeddable chunks for an item from its append-only extractions:
 * the latest succeeded transcription (chunked with segment timestamps) followed
 * by the latest succeeded summary (title + markdown + off-topic, chunked as
 * timeless prose). `chunkIndex` runs across the whole set so ordering is stable.
 * Returns no chunks when there is nothing to embed yet.
 */
export function buildEmbeddableChunks(
  item: InboxItemEntity,
  maxChars: number = DEFAULT_MAX_CHARS,
): EmbeddingContext {
  const extractions = item.extractions ?? [];
  const chunks: EmbeddableChunk[] = [];
  let index = 0;

  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content) {
    for (const chunk of chunkTranscript(
      transcription.content,
      transcription.segments ?? null,
      maxChars,
    )) {
      chunks.push({
        source: 'transcript',
        chunkIndex: index++,
        text: chunk.text,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
      });
    }
  }
  const transcriptChunks = chunks.length;

  const summary = latestOfKind(extractions, 'summary');
  if (summary?.status === 'succeeded' && summary.content) {
    const text = summaryText(summary.content);
    if (text) {
      for (const piece of chunkPlainText(text, maxChars)) {
        chunks.push({
          source: 'summary',
          chunkIndex: index++,
          text: piece,
          startSeconds: null,
          endSeconds: null,
        });
      }
    }
  }

  return {
    chunks,
    transcriptChunks,
    summaryChunks: chunks.length - transcriptChunks,
  };
}

/** Flatten a stored summary payload (JSON) into embeddable prose. */
function summaryText(content: string): string {
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return '';
    const { title, markdown, offTopic } = parsed.data;
    return [title, markdown, offTopic ?? ''].filter(Boolean).join('\n\n').trim();
  } catch {
    return '';
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
