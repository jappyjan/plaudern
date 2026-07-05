import { parseClassificationResponse } from '../../topics/src/providers/openai.provider';
import { topicFixtures } from './fixtures/topics.fixtures';
import { aggregate, expectAtLeast, formatScore, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

type Assignment = { topicId: string; confidence: number };

/** An assignment matches on topic id and the (deduped/clamped) confidence. */
const assignmentMatches = (p: Assignment, e: Assignment) =>
  p.topicId === e.topicId && Math.abs(p.confidence - e.confidence) < 1e-9;

describe('topics classification quality (JJ-1)', () => {
  const scored = topicFixtures.map((fx) => ({
    fx,
    score: scoreSet(
      parseClassificationResponse(fx.response, fx.validTopicIds),
      fx.expected,
      assignmentMatches,
    ),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`topics · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('topics (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });
});
