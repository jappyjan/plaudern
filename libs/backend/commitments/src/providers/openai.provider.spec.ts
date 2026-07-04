import { buildUserPrompt, parseCommitmentsResponse } from './openai.provider';

describe('parseCommitmentsResponse', () => {
  it('parses a well-formed reply', () => {
    const out = parseCommitmentsResponse(
      JSON.stringify({
        commitments: [
          {
            direction: 'owed_by_me',
            counterparty: 'Anna',
            description: 'send the draft',
            duePhrase: 'by Friday',
            sourceQuote: "I'll send you the draft by Friday",
          },
          {
            direction: 'owed_to_me',
            counterparty: 'Tom',
            description: 'check with the landlord',
            duePhrase: null,
            sourceQuote: "Tom said he'd check with the landlord",
          },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      direction: 'owed_by_me',
      counterparty: 'Anna',
      description: 'send the draft',
      duePhrase: 'by Friday',
    });
    expect(out[1].direction).toBe('owed_to_me');
  });

  it('tolerates code-fence wrapping and applies field defaults', () => {
    const out = parseCommitmentsResponse(
      '```json\n{ "commitments": [ { "direction": "owed_by_me", "description": "call the clinic" } ] }\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      direction: 'owed_by_me',
      counterparty: '',
      description: 'call the clinic',
      duePhrase: null,
      sourceQuote: null,
    });
  });

  it('drops malformed entries and bad directions rather than throwing', () => {
    const out = parseCommitmentsResponse(
      JSON.stringify({
        commitments: [
          { direction: 'sideways', description: 'nope' },
          { direction: 'owed_by_me' }, // missing description
          { direction: 'owed_to_me', description: 'valid one' },
          'garbage',
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('valid one');
  });

  it('returns [] when nothing parses', () => {
    expect(parseCommitmentsResponse('the model refused to answer')).toEqual([]);
    expect(parseCommitmentsResponse('{ "commitments": [] }')).toEqual([]);
  });
});

describe('buildUserPrompt', () => {
  it('includes metadata, the speaker roster with the owner marker, and the transcript', () => {
    const prompt = buildUserPrompt({
      transcript: 'SPEAKER_00: I will send the draft by Friday.',
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
    expect(prompt).toContain('I will send the draft by Friday.');
  });
});
