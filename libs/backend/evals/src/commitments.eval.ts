import type { ExtractedCommitment } from '@plaudern/contracts';
import { parseCommitmentsResponse } from '../../commitments/src/providers/openai.provider';
import { resolveDueDate } from '../../commitments/src/date-resolver';
import {
  commitmentFixtures,
  dueDateCases,
  DUE_DATE_ANCHOR,
} from './fixtures/commitments.fixtures';
import { aggregate, expectAtLeast, formatScore, norm, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

/**
 * A commitment matches when direction, the obligation phrasing AND the
 * counterparty agree — so a regression that mis-attributes who owes whom (the
 * "right speaker/counterparty" question) shows up as a miss.
 */
const commitmentMatches = (p: ExtractedCommitment, e: ExtractedCommitment) =>
  p.direction === e.direction &&
  norm(p.description) === norm(e.description) &&
  norm(p.counterparty) === norm(e.counterparty);

describe('commitments extraction quality (JJ-1)', () => {
  const scored = commitmentFixtures.map((fx) => ({
    fx,
    score: scoreSet(parseCommitmentsResponse(fx.response), fx.expected, commitmentMatches),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`commitments · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('commitments (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });

  // "Did it find the right due date?" — score the deterministic resolver that
  // turns the model's raw phrase into a concrete instant.
  describe('due-date resolution accuracy', () => {
    let correct = 0;
    for (const c of dueDateCases) {
      it(`resolves ${JSON.stringify(c.phrase)} → ${c.expected ?? 'null'}`, () => {
        const got = resolveDueDate(c.phrase, DUE_DATE_ANCHOR);
        expect(got).toBe(c.expected);
        correct++;
      });
    }
    afterAll(() => {
      const accuracy = correct / dueDateCases.length;
      console.log(`commitments · due-date accuracy: ${(accuracy * 100).toFixed(1)}%`);
      expect(accuracy).toBeGreaterThanOrEqual(0.9);
    });
  });
});
