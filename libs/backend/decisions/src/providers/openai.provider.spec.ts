import { buildUserPrompt, parseDecisionsResponse } from './openai.provider';

describe('parseDecisionsResponse', () => {
  it('parses a well-formed reply', () => {
    const out = parseDecisionsResponse(
      JSON.stringify({
        decisions: [
          {
            decision: 'go with the cheaper vendor',
            context: 'the budget is tight',
            participants: 'Anna and me',
            confidence: 0.9,
            sourceQuote: 'We decided to go with the cheaper vendor',
          },
          {
            decision: 'postpone the trip',
            context: null,
            participants: 'the team',
            confidence: 0.7,
            sourceQuote: 'We agreed to postpone the trip',
          },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      decision: 'go with the cheaper vendor',
      context: 'the budget is tight',
      participants: 'Anna and me',
      confidence: 0.9,
    });
    expect(out[1].decision).toBe('postpone the trip');
    expect(out[1].participants).toBe('the team');
  });

  it('tolerates code-fence wrapping and applies field defaults', () => {
    const out = parseDecisionsResponse(
      '```json\n{ "decisions": [ { "decision": "switch banks" } ] }\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      decision: 'switch banks',
      context: null,
      participants: '',
      confidence: null,
      sourceQuote: null,
      sourceTimestamp: null,
    });
  });

  it('drops malformed entries rather than throwing', () => {
    const out = parseDecisionsResponse(
      JSON.stringify({
        decisions: [
          { context: 'no decision field' }, // missing decision
          { decision: '' }, // empty decision
          { decision: 'valid one' },
          'garbage',
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].decision).toBe('valid one');
  });

  it('returns [] when nothing parses', () => {
    expect(parseDecisionsResponse('the model refused to answer')).toEqual([]);
    expect(parseDecisionsResponse('{ "decisions": [] }')).toEqual([]);
  });
});

describe('buildUserPrompt', () => {
  it('includes metadata, the speaker roster, and the transcript', () => {
    const prompt = buildUserPrompt({
      transcript: 'SPEAKER_00: We decided to go with the cheaper vendor.',
      speakers: [
        { label: 'SPEAKER_00', displayName: 'Me' },
        { label: 'SPEAKER_01', displayName: 'Anna' },
      ],
      language: 'en',
      occurredAt: '2026-07-01T09:00:00.000Z',
    });
    expect(prompt).toContain('recorded at: 2026-07-01T09:00:00.000Z');
    expect(prompt).toContain('SPEAKER_00: Me');
    expect(prompt).toContain('SPEAKER_01: Anna');
    expect(prompt).toContain('We decided to go with the cheaper vendor.');
  });
});
