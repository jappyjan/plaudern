import type { ConfigService } from '@nestjs/config';
import {
  buildRelationsUserPrompt,
  OpenAiRelationExtractionProvider,
  parseRelationsResponse,
  RELATIONS_SYSTEM_PROMPT,
} from './openai-relations.provider';
import type { RelationExtractionInput } from '../relations.provider';

/** Minimal ConfigService stand-in — the provider only ever calls `.get(key, default)`. */
function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

// Auditing is exercised in the audit lib's own spec; here it is a no-op stub.
const audit = { record: async () => undefined } as any;

const baseInput: RelationExtractionInput = {
  text: 'Angela works at CDU. She met Bob in Berlin.',
  entities: [
    { name: 'Angela Merkel', type: 'person' },
    { name: 'CDU', type: 'organization' },
    { name: 'Berlin', type: 'place' },
  ],
  language: 'en',
  occurredAt: '2026-07-01T10:00:00Z',
};

describe('buildRelationsUserPrompt', () => {
  it('embeds the transcript and lists every legal endpoint with its type', () => {
    const prompt = buildRelationsUserPrompt(baseInput);
    expect(prompt).toContain('Angela works at CDU.');
    expect(prompt).toContain('- Angela Merkel (person)');
    expect(prompt).toContain('- CDU (organization)');
    expect(prompt).toContain('- Berlin (place)');
  });

  it('includes the recording metadata when present', () => {
    const prompt = buildRelationsUserPrompt(baseInput);
    expect(prompt).toContain('language: en');
    expect(prompt).toContain('recorded at: 2026-07-01T10:00:00Z');
  });

  it('omits the metadata line when nothing is known', () => {
    expect(
      buildRelationsUserPrompt({ text: 'hello', entities: [] }),
    ).not.toContain('Recording metadata');
  });
});

describe('parseRelationsResponse', () => {
  it('parses a clean JSON object', () => {
    const out = parseRelationsResponse(
      JSON.stringify({
        relations: [
          {
            type: 'works_at',
            source: 'Angela Merkel',
            target: 'CDU',
            label: 'as chancellor',
            confidence: 0.9,
          },
          { type: 'located_in', source: 'CDU', target: 'Berlin' },
        ],
      }),
    );
    expect(out).toEqual([
      {
        type: 'works_at',
        source: 'Angela Merkel',
        target: 'CDU',
        label: 'as chancellor',
        confidence: 0.9,
      },
      { type: 'located_in', source: 'CDU', target: 'Berlin', label: undefined, confidence: undefined },
    ]);
  });

  it('tolerates a ```json code fence', () => {
    const out = parseRelationsResponse(
      '```json\n{"relations":[{"type":"owns","source":"Alice","target":"the car"}]}\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'owns', source: 'Alice', target: 'the car' });
  });

  it('drops entries with an unknown type or missing endpoint', () => {
    const out = parseRelationsResponse(
      JSON.stringify({
        relations: [
          { type: 'married_to', source: 'A', target: 'B' }, // not in the vocabulary
          { type: 'owns', source: '  ', target: 'B' },
          { type: 'owns', source: 'A' },
          { type: 'owns', source: 'A', target: 'B' },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'owns', source: 'A', target: 'B' });
  });

  it('drops out-of-range or non-numeric confidences but keeps the relation', () => {
    const out = parseRelationsResponse(
      JSON.stringify({
        relations: [
          { type: 'owns', source: 'A', target: 'B', confidence: 7 },
          { type: 'owns', source: 'A', target: 'C', confidence: 'high' },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].confidence).toBeUndefined();
    expect(out[1].confidence).toBeUndefined();
  });

  it('returns an empty array for a missing/empty relations field', () => {
    expect(parseRelationsResponse(JSON.stringify({ relations: [] }))).toEqual([]);
    expect(parseRelationsResponse(JSON.stringify({}))).toEqual([]);
  });

  it('recovers a JSON object embedded in surrounding prose', () => {
    const out = parseRelationsResponse(
      'Sure: {"relations":[{"type":"part_of","source":"A","target":"B"}]} — done',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'part_of', source: 'A', target: 'B' });
  });

  it('throws on non-JSON content', () => {
    expect(() => parseRelationsResponse('not json at all')).toThrow();
  });
});

describe('OpenAiRelationExtractionProvider.enabled', () => {
  it('shares the entity-extraction gating (disabled without key or flag)', () => {
    expect(new OpenAiRelationExtractionProvider(fakeConfig({}), audit).enabled).toBe(false);
    expect(
      new OpenAiRelationExtractionProvider(
        fakeConfig({ ENTITY_EXTRACTION_API_KEY: 'sk-test' }),
        audit,
      ).enabled,
    ).toBe(true);
    expect(
      new OpenAiRelationExtractionProvider(
        fakeConfig({ ENTITY_EXTRACTION_ENABLED: 'true' }),
        audit,
      ).enabled,
    ).toBe(true);
  });

  it('throws a descriptive error from extract() when disabled', async () => {
    const provider = new OpenAiRelationExtractionProvider(fakeConfig({}), audit);
    await expect(provider.extract(baseInput)).rejects.toThrow(/ENTITY_EXTRACTION_ENABLED/);
  });
});

describe('RELATIONS_SYSTEM_PROMPT', () => {
  it('enumerates every supported relation type', () => {
    for (const type of [
      'works_at',
      'located_in',
      'involved_in',
      'discussed_with',
      'promised_to',
      'related_to',
      'part_of',
      'owns',
    ]) {
      expect(RELATIONS_SYSTEM_PROMPT).toContain(type);
    }
  });
});
