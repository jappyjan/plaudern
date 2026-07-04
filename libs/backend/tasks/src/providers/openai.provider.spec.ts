import { buildUserPrompt, parseTasksResponse } from './openai.provider';

describe('parseTasksResponse', () => {
  it('parses a well-formed task list', () => {
    const tasks = parseTasksResponse(
      JSON.stringify({
        tasks: [
          { title: 'Book the dentist', dueDate: '2026-07-10', quote: 'I need to book the dentist.' },
          { title: 'Email Anna', dueDate: null, quote: 'Remember to email Anna.' },
        ],
      }),
    );
    expect(tasks).toEqual([
      { title: 'Book the dentist', dueDate: '2026-07-10', quote: 'I need to book the dentist.' },
      { title: 'Email Anna', dueDate: null, quote: 'Remember to email Anna.' },
    ]);
  });

  it('tolerates code-fence wrapping and surrounding prose', () => {
    const content = 'Sure! Here you go:\n```json\n{ "tasks": [ { "title": "Renew passport" } ] }\n```';
    const tasks = parseTasksResponse(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Renew passport', dueDate: null, quote: null });
  });

  it('drops malformed entries and non-ISO due dates rather than throwing', () => {
    const tasks = parseTasksResponse(
      JSON.stringify({
        tasks: [
          { title: '', quote: 'empty title dropped' },
          { title: 'Valid', dueDate: 'next week', quote: 42 },
          'not-an-object',
          { nope: true },
        ],
      }),
    );
    expect(tasks).toEqual([{ title: 'Valid', dueDate: null, quote: null }]);
  });

  it('returns an empty array for a no-tasks reply', () => {
    expect(parseTasksResponse(JSON.stringify({ tasks: [] }))).toEqual([]);
    expect(parseTasksResponse('{"tasks": []}')).toEqual([]);
  });

  it('throws only when the reply is not JSON at all', () => {
    expect(() => parseTasksResponse('totally not json')).toThrow(/not valid JSON/);
  });
});

describe('buildUserPrompt', () => {
  it('includes metadata and the source text', () => {
    const prompt = buildUserPrompt({
      text: 'I should renew my passport.',
      language: 'en',
      occurredAt: '2026-07-01T10:00:00Z',
    });
    expect(prompt).toContain('language: en');
    expect(prompt).toContain('recorded at: 2026-07-01T10:00:00Z');
    expect(prompt).toContain('I should renew my passport.');
  });
});
