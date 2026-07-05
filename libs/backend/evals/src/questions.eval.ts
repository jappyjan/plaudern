import type { ExtractedQuestion } from '@plaudern/contracts';
import { parseQuestionsResponse } from '../../questions/src/providers/openai.provider';
import { questionFixtures } from './fixtures/questions.fixtures';
import { aggregate, expectAtLeast, formatScore, norm, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

/** A question matches on direction, phrasing, counterparty and answered flag. */
const questionMatches = (p: ExtractedQuestion, e: ExtractedQuestion) =>
  p.direction === e.direction &&
  norm(p.question) === norm(e.question) &&
  norm(p.counterparty) === norm(e.counterparty) &&
  p.answered === e.answered;

describe('questions extraction quality (JJ-1)', () => {
  const scored = questionFixtures.map((fx) => ({
    fx,
    score: scoreSet(parseQuestionsResponse(fx.response), fx.expected, questionMatches),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`questions · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('questions (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });
});
