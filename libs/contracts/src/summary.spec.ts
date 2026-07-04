import { summaryPayloadSchema, summarySchema } from './summary';

describe('summaryPayloadSchema', () => {
  // Summaries persisted before off-topic detection existed have no `offTopic`
  // key; the schema must keep parsing them so old rows stay readable.
  it('parses a legacy payload without offTopic', () => {
    const parsed = summaryPayloadSchema.parse({
      title: 'Weekly sync',
      layout: 'meeting',
      markdown: '## Notes',
    });
    expect(parsed.offTopic).toBeUndefined();
  });

  it('parses offTopic as a string or null', () => {
    const base = { title: 'T', layout: 'note', markdown: 'body' };
    expect(
      summaryPayloadSchema.parse({ ...base, offTopic: '- weather chat' }).offTopic,
    ).toBe('- weather chat');
    expect(summaryPayloadSchema.parse({ ...base, offTopic: null }).offTopic).toBeNull();
  });
});

describe('summarySchema', () => {
  it('defaults offTopic to null when the API omits it', () => {
    const parsed = summarySchema.parse({
      status: 'succeeded',
      title: 'T',
      layout: 'note',
      markdown: 'body',
      provider: 'openai:test',
      model: 'test',
      error: null,
      createdAt: null,
      completedAt: null,
      speakers: [],
    });
    expect(parsed.offTopic).toBeNull();
  });
});
