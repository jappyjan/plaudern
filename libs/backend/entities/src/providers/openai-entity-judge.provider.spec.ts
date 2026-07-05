import type { EntityJudgeInput } from '../entity-judge.provider';
import { buildJudgePrompt, parseJudgeResponse } from './openai-entity-judge.provider';

const INPUT: EntityJudgeInput = {
  subject: { name: 'Foo', type: 'product', aliases: [] },
  candidate: { name: 'Foo', type: 'organization', aliases: ['Foo Inc'] },
};

describe('parseJudgeResponse', () => {
  it('maps a well-formed verdict', () => {
    const decision = parseJudgeResponse(
      JSON.stringify({
        sameThing: true,
        recommendedType: 'product',
        survivor: 'subject',
        confidence: 0.82,
        rationale: 'same company',
      }),
      INPUT,
    );
    expect(decision).toEqual({
      sameThing: true,
      recommendedType: 'product',
      survivor: 'subject',
      confidence: 0.82,
      rationale: 'same company',
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    const content = 'Sure:\n```json\n{"sameThing":false,"survivor":"candidate","confidence":0.1}\n```';
    const decision = parseJudgeResponse(content, INPUT);
    expect(decision.sameThing).toBe(false);
    expect(decision.survivor).toBe('candidate');
  });

  it('falls back to the survivor type for an invalid recommendedType and clamps confidence', () => {
    const decision = parseJudgeResponse(
      JSON.stringify({
        sameThing: true,
        recommendedType: 'not-a-type',
        survivor: 'candidate',
        confidence: 5,
      }),
      INPUT,
    );
    // survivor 'candidate' → its type (organization) is the fallback.
    expect(decision.recommendedType).toBe('organization');
    expect(decision.confidence).toBe(1);
  });

  it('coerces an unknown survivor to subject and missing confidence to 0', () => {
    const decision = parseJudgeResponse(
      JSON.stringify({ sameThing: true, recommendedType: 'product', survivor: 'both' }),
      INPUT,
    );
    expect(decision.survivor).toBe('subject');
    expect(decision.confidence).toBe(0);
  });
});

describe('buildJudgePrompt', () => {
  it('includes both sides and any web snippets', () => {
    const prompt = buildJudgePrompt({ ...INPUT, webSnippets: ['Foo is a SaaS product.'] });
    expect(prompt).toContain('Subject entity');
    expect(prompt).toContain('Candidate entity');
    expect(prompt).toContain('also known as: Foo Inc');
    expect(prompt).toContain('Web context:');
    expect(prompt).toContain('Foo is a SaaS product.');
  });
});
