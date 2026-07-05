import { buildResearchPrompt, parseResearchSnippets } from './openai-web-research.provider';

describe('parseResearchSnippets', () => {
  it('returns trimmed non-empty snippets', () => {
    const out = parseResearchSnippets(
      JSON.stringify({ snippets: ['  Foo is a product.  ', '', 'Made by Bar Inc.'] }),
    );
    expect(out).toEqual(['Foo is a product.', 'Made by Bar Inc.']);
  });

  it('tolerates fences/prose and a missing array', () => {
    expect(parseResearchSnippets('```json\n{"snippets":[]}\n```')).toEqual([]);
    expect(parseResearchSnippets(JSON.stringify({ nope: true }))).toEqual([]);
  });

  it('caps the number of snippets', () => {
    const many = Array.from({ length: 20 }, (_, i) => `snippet ${i}`);
    expect(parseResearchSnippets(JSON.stringify({ snippets: many }).toString()).length).toBe(5);
  });
});

describe('buildResearchPrompt', () => {
  it('sends only the name, type and context hint', () => {
    const prompt = buildResearchPrompt({
      name: 'Foo',
      type: 'product',
      context: 'possibly the same as "Foo" (organization)',
    });
    expect(prompt).toContain('Entity name: Foo');
    expect(prompt).toContain('Extracted as type: product');
    expect(prompt).toContain('Context: possibly the same as "Foo" (organization)');
  });
});
