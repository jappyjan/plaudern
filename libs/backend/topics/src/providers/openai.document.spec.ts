import { buildUserPrompt, parseDocumentResponse } from './openai.document';
import type { TopicDocumentInput } from '../topic-document.provider';

describe('parseDocumentResponse', () => {
  it('parses a plain JSON object', () => {
    expect(parseDocumentResponse('{"markdown":"## Overview\\nHi [1]"}')).toBe('## Overview\nHi [1]');
  });

  it('tolerates ```json code fences', () => {
    const content = '```json\n{"markdown":"## Overview\\nBody"}\n```';
    expect(parseDocumentResponse(content)).toBe('## Overview\nBody');
  });

  it('throws when the markdown body is missing or empty', () => {
    expect(() => parseDocumentResponse('{"markdown":""}')).toThrow(/no markdown body/);
    expect(() => parseDocumentResponse('not json')).toThrow(/not valid JSON/);
  });
});

describe('buildUserPrompt', () => {
  const base: TopicDocumentInput = {
    topicName: 'Hausbau',
    topicDescription: 'The house build',
    sources: [
      {
        marker: 1,
        inboxItemId: 'i1',
        title: 'Foundation day',
        occurredAt: '2026-06-01T10:00:00Z',
        text: 'We poured the foundation.',
      },
      {
        marker: 2,
        inboxItemId: 'i2',
        title: null,
        occurredAt: '2026-06-10T10:00:00Z',
        text: 'We finished the roof.',
      },
    ],
    previousMarkdown: null,
  };

  it('numbers the sources for citation and notes there is no prior document', () => {
    const prompt = buildUserPrompt(base);
    expect(prompt).toContain('Topic: Hausbau');
    expect(prompt).toContain('[1] Foundation day');
    expect(prompt).toContain('[2] Untitled');
    expect(prompt).toContain('There is no document yet');
  });

  it('includes the current document when updating', () => {
    const prompt = buildUserPrompt({ ...base, previousMarkdown: '## Overview\nPrior.' });
    expect(prompt).toContain('Current document');
    expect(prompt).toContain('## Overview\nPrior.');
  });
});
