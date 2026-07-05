import type { ExtractedDecision } from '@plaudern/contracts';
import { parseDecisionsResponse } from '../../decisions/src/providers/openai.provider';
import { decisionFixtures } from './fixtures/decisions.fixtures';
import { aggregate, expectAtLeast, formatScore, norm, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

/** A decision matches on the statement AND the participant attribution. */
const decisionMatches = (p: ExtractedDecision, e: ExtractedDecision) =>
  norm(p.decision) === norm(e.decision) && norm(p.participants) === norm(e.participants);

describe('decisions extraction quality (JJ-1)', () => {
  const scored = decisionFixtures.map((fx) => ({
    fx,
    score: scoreSet(parseDecisionsResponse(fx.response), fx.expected, decisionMatches),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`decisions · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('decisions (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });
});
