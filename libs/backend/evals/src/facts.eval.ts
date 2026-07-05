import type { ExtractedFact } from '@plaudern/contracts';
// Import the SHIPPING parser directly (not the lib barrel) so the eval scores
// the exact deterministic post-LLM code path without booting the Nest module.
import { parseFactsResponse } from '../../facts/src/providers/openai.provider';
import { factFixtures } from './fixtures/facts.fixtures';
import { aggregate, expectAtLeast, formatScore, norm, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

/** A fact matches when subject, attribute, value and the exclusive flag agree. */
const factMatches = (p: ExtractedFact, e: ExtractedFact) =>
  norm(p.person) === norm(e.person) &&
  norm(p.attribute) === norm(e.attribute) &&
  norm(p.value) === norm(e.value) &&
  p.exclusive === e.exclusive;

describe('facts extraction quality (JJ-1)', () => {
  const scored = factFixtures.map((fx) => ({
    fx,
    score: scoreSet(parseFactsResponse(fx.response), fx.expected, factMatches),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`facts · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('facts (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });
});
