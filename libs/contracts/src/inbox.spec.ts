import { inboxItemSchema, inboxListResponseSchema } from './inbox';

const baseExtraction = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  provider: 'openai:test',
  status: 'succeeded',
  content: 'hello',
  segments: null,
  language: null,
  error: null,
  createdAt: '2026-07-05T12:00:00.000Z',
  completedAt: '2026-07-05T12:00:01.000Z',
};

const baseItem = {
  id: '22222222-2222-4222-8222-222222222222',
  sourceType: 'audio',
  occurredAt: '2026-07-05T12:00:00.000Z',
  ingestedAt: '2026-07-05T12:00:00.000Z',
  metadata: null,
  source: null,
};

describe('inboxItemSchema extractions (forward compatibility)', () => {
  // A newer server can emit an extraction kind that this client build predates.
  // One such row must not fail the whole inbox parse — it is simply dropped.
  it('drops extractions whose kind this build does not recognize', () => {
    const parsed = inboxItemSchema.parse({
      ...baseItem,
      extractions: [
        { ...baseExtraction, kind: 'transcription' },
        { ...baseExtraction, id: '33333333-3333-4333-8333-333333333333', kind: 'a-future-kind' },
        { ...baseExtraction, id: '44444444-4444-4444-8444-444444444444', kind: 'summary' },
      ],
    });

    expect(parsed.extractions.map((e) => e.kind)).toEqual(['transcription', 'summary']);
  });

  it('parses an item whose only extraction has an unknown kind as empty', () => {
    const parsed = inboxItemSchema.parse({
      ...baseItem,
      extractions: [{ ...baseExtraction, kind: 'a-future-kind' }],
    });

    expect(parsed.extractions).toEqual([]);
  });

  // Dropping is scoped to unrecognized kinds only: a row with a *known* kind
  // that is otherwise malformed is still a real bug and must still throw.
  it('still rejects a known-kind extraction with an invalid shape', () => {
    expect(() =>
      inboxItemSchema.parse({
        ...baseItem,
        extractions: [{ ...baseExtraction, kind: 'summary', status: 'not-a-status' }],
      }),
    ).toThrow();
  });

  it('keeps unknown-kind tolerance through the list response schema', () => {
    const parsed = inboxListResponseSchema.parse({
      items: [
        {
          ...baseItem,
          extractions: [
            { ...baseExtraction, kind: 'transcription' },
            { ...baseExtraction, id: '55555555-5555-4555-8555-555555555555', kind: 'a-future-kind' },
          ],
        },
      ],
      nextCursor: null,
    });

    expect(parsed.items[0].extractions.map((e) => e.kind)).toEqual(['transcription']);
  });
});
