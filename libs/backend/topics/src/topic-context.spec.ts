import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { SummaryPayload } from '@plaudern/contracts';
import { buildTopicContent, DEFAULT_MAX_CHARS } from './topic-context';

/** Minimal extraction row for exercising the pure content builder. */
function row(
  kind: ExtractedPayloadEntity['kind'],
  status: ExtractedPayloadEntity['status'],
  createdAt: string,
  fields: Partial<Pick<ExtractedPayloadEntity, 'content' | 'language'>> = {},
): ExtractedPayloadEntity {
  return { kind, status, createdAt: new Date(createdAt), content: null, language: null, ...fields } as ExtractedPayloadEntity;
}

function item(extractions: ExtractedPayloadEntity[]): InboxItemEntity {
  return { id: 'item-1', extractions } as InboxItemEntity;
}

function summaryContent(overrides: Partial<SummaryPayload> = {}): string {
  return JSON.stringify({
    title: 'House build kickoff',
    layout: 'note',
    markdown: 'We poured the foundation.',
    ...overrides,
  } satisfies SummaryPayload);
}

describe('buildTopicContent', () => {
  it('prefers the latest succeeded summary (title + markdown + off-topic)', () => {
    const result = buildTopicContent(
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z', { content: 'raw transcript', language: 'en' }),
        row('summary', 'succeeded', '2026-07-01T10:05:00Z', {
          content: summaryContent({ offTopic: 'weather chat' }),
        }),
      ]),
    );
    expect(result?.content).toContain('House build kickoff');
    expect(result?.content).toContain('We poured the foundation.');
    expect(result?.content).toContain('weather chat');
  });

  it('falls back to the transcription when there is no summary yet', () => {
    const result = buildTopicContent(
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z', { content: 'raw transcript', language: 'de' })]),
    );
    expect(result?.content).toBe('raw transcript');
    expect(result?.language).toBe('de');
  });

  it('falls back to the transcription when the summary failed', () => {
    const result = buildTopicContent(
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z', { content: 'raw transcript' }),
        row('summary', 'failed', '2026-07-01T10:05:00Z'),
      ]),
    );
    expect(result?.content).toBe('raw transcript');
  });

  it('only considers the latest attempt of each kind (append-only history)', () => {
    const result = buildTopicContent(
      item([
        row('summary', 'succeeded', '2026-07-01T10:00:00Z', { content: summaryContent({ title: 'Old' }) }),
        row('summary', 'succeeded', '2026-07-01T11:00:00Z', { content: summaryContent({ title: 'New' }) }),
      ]),
    );
    expect(result?.content).toContain('New');
    expect(result?.content).not.toContain('Old');
  });

  it('returns null when there is nothing to classify', () => {
    expect(buildTopicContent(item([]))).toBeNull();
    expect(
      buildTopicContent(item([row('transcription', 'processing', '2026-07-01T10:00:00Z')])),
    ).toBeNull();
  });

  it('truncates very long content to the char budget', () => {
    const long = 'a'.repeat(DEFAULT_MAX_CHARS + 500);
    const result = buildTopicContent(
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z', { content: long })]),
    );
    expect(result?.content.length).toBe(DEFAULT_MAX_CHARS);
  });
});
