import { buildUserPrompt, parseQuestionsResponse } from './openai.provider';

describe('parseQuestionsResponse', () => {
  it('parses a well-formed reply', () => {
    const out = parseQuestionsResponse(
      JSON.stringify({
        questions: [
          {
            direction: 'asked_by_me',
            counterparty: 'Anna',
            question: 'did the landlord ever reply',
            answered: false,
            sourceQuote: 'Did you ever hear back from the landlord?',
          },
          {
            direction: 'asked_of_me',
            counterparty: 'Tom',
            question: 'when will the report be ready',
            answered: true,
            sourceQuote: 'Tom asked when the report would be ready',
          },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      direction: 'asked_by_me',
      counterparty: 'Anna',
      question: 'did the landlord ever reply',
      answered: false,
    });
    expect(out[1].direction).toBe('asked_of_me');
    expect(out[1].answered).toBe(true);
  });

  it('tolerates code-fence wrapping and applies field defaults', () => {
    const out = parseQuestionsResponse(
      '```json\n{ "questions": [ { "direction": "asked_by_me", "question": "where did I leave the keys" } ] }\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      direction: 'asked_by_me',
      counterparty: '',
      question: 'where did I leave the keys',
      answered: false,
      sourceQuote: null,
      sourceTimestamp: null,
    });
  });

  it('drops malformed entries and bad directions rather than throwing', () => {
    const out = parseQuestionsResponse(
      JSON.stringify({
        questions: [
          { direction: 'sideways', question: 'nope' },
          { direction: 'asked_by_me' }, // missing question
          { direction: 'asked_of_me', question: 'valid one' },
          'garbage',
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].question).toBe('valid one');
  });

  it('returns [] when nothing parses', () => {
    expect(parseQuestionsResponse('the model refused to answer')).toEqual([]);
    expect(parseQuestionsResponse('{ "questions": [] }')).toEqual([]);
  });
});

describe('buildUserPrompt', () => {
  it('includes metadata, the speaker roster with the owner marker, and the transcript', () => {
    const prompt = buildUserPrompt({
      transcript: 'SPEAKER_00: Did you ever hear back from the landlord?',
      speakers: [
        { label: 'SPEAKER_00', displayName: 'Me' },
        { label: 'SPEAKER_01', displayName: 'Anna' },
      ],
      ownerLabel: 'SPEAKER_00',
      language: 'en',
      occurredAt: '2026-07-01T09:00:00.000Z',
    });
    expect(prompt).toContain('recorded at: 2026-07-01T09:00:00.000Z');
    expect(prompt).toContain('SPEAKER_00: Me (the owner / me)');
    expect(prompt).toContain('SPEAKER_01: Anna');
    expect(prompt).toContain('Did you ever hear back from the landlord?');
  });
});
