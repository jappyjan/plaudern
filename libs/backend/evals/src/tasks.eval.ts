import type { ExtractedTask } from '@plaudern/contracts';
import { parseTasksResponse } from '../../tasks/src/providers/openai.provider';
import { taskFixtures } from './fixtures/tasks.fixtures';
import { aggregate, expectAtLeast, formatScore, norm, scoreSet } from './harness';

const THRESHOLDS = { precision: 0.9, recall: 0.9, f1: 0.9 };

/**
 * A task matches when the title AND the (normalized) due date agree — pinning
 * `normalizeDate`, which must keep ISO dates and drop natural-language phrases.
 */
const taskMatches = (p: ExtractedTask, e: ExtractedTask) =>
  norm(p.title) === norm(e.title) && (p.dueDate ?? null) === (e.dueDate ?? null);

describe('tasks extraction quality (JJ-1)', () => {
  const scored = taskFixtures.map((fx) => ({
    fx,
    score: scoreSet(parseTasksResponse(fx.response), fx.expected, taskMatches),
  }));

  for (const { fx, score } of scored) {
    it(`parses "${fx.name}" without loss`, () => {
      console.log(formatScore(`tasks · ${fx.name}`, score));
      expect(score.falseNegatives).toBe(0);
      expect(score.falsePositives).toBe(0);
    });
  }

  it('clears the pooled precision/recall gate', () => {
    expectAtLeast('tasks (pooled)', aggregate(scored.map((s) => s.score)), THRESHOLDS);
  });
});
