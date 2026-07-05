/**
 * Tiny precision/recall scoring harness for the extraction quality evals (JJ-1).
 *
 * An eval measures the DETERMINISTIC post-LLM code — the parse/normalize/dedup/
 * date-resolution paths that turn a raw model reply into the structured rows we
 * store. Each fixture pairs a recorded model reply with the human-labeled rows
 * we expect the code to emit; the harness matches emitted rows against expected
 * rows with a caller-supplied equality predicate and reports precision, recall
 * and F1. A regression in the parsing code (a dropped field, a broken dedup, a
 * mis-resolved date) shows up as a score below the kind's threshold, failing CI.
 */

/**
 * One labeled golden case for a kind: a recorded model reply and the rows the
 * deterministic post-LLM code is expected to emit from it. The reply is fed
 * through the REAL parser verbatim (code fences, prose and malformed entries
 * included) so the eval exercises the shipping normalization/validation path.
 */
export interface ExtractionFixture<T> {
  name: string;
  /** A recorded/synthetic model reply, parsed exactly as production would. */
  response: string;
  /** Human-labeled rows the code should emit (order-independent). */
  expected: T[];
}

export interface ScoreCounts {
  /** Emitted rows that matched an expected row. */
  truePositives: number;
  /** Emitted rows with no expected match (spurious / hallucinated rows). */
  falsePositives: number;
  /** Expected rows the code failed to emit (missed rows). */
  falseNegatives: number;
}

export interface Score extends ScoreCounts {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Greedy one-to-one matching of `predicted` against `expected` using `matches`.
 * Each expected row consumes at most one predicted row, so duplicate emissions
 * are penalised as false positives (which is what a broken dedup would produce).
 */
export function scoreSet<P, E>(
  predicted: readonly P[],
  expected: readonly E[],
  matches: (predicted: P, expected: E) => boolean,
): Score {
  const usedPredicted = new Set<number>();
  let truePositives = 0;

  for (const exp of expected) {
    let matchedIndex = -1;
    for (let i = 0; i < predicted.length; i++) {
      if (usedPredicted.has(i)) continue;
      if (matches(predicted[i], exp)) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex >= 0) {
      usedPredicted.add(matchedIndex);
      truePositives++;
    }
  }

  const falsePositives = predicted.length - usedPredicted.size;
  const falseNegatives = expected.length - truePositives;
  return finalize({ truePositives, falsePositives, falseNegatives });
}

/** Pool raw counts from several fixtures into one micro-averaged score. */
export function aggregate(counts: readonly ScoreCounts[]): Score {
  const summed = counts.reduce<ScoreCounts>(
    (acc, c) => ({
      truePositives: acc.truePositives + c.truePositives,
      falsePositives: acc.falsePositives + c.falsePositives,
      falseNegatives: acc.falseNegatives + c.falseNegatives,
    }),
    { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
  );
  return finalize(summed);
}

function finalize(counts: ScoreCounts): Score {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = counts;
  // No expected and none emitted is a perfect score (an empty transcript should
  // yield an empty extraction); guard the 0/0 divisions accordingly.
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 };
}

/** Case/space-insensitive comparison key for free-text fields. */
export function norm(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Pretty one-line score for CI logs, so the numbers are visible evidence. */
export function formatScore(label: string, s: Score): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    `${label}: P=${pct(s.precision)} R=${pct(s.recall)} F1=${pct(s.f1)} ` +
    `(tp=${s.truePositives} fp=${s.falsePositives} fn=${s.falseNegatives})`
  );
}

export interface Thresholds {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Jest-friendly gate: logs the score, then asserts it clears every threshold.
 * Kept dependency-light (throws plain Errors) so it reads the same whether run
 * under jest or a bare node harness.
 */
export function expectAtLeast(label: string, score: Score, thresholds: Thresholds): void {
  // eslint-disable-next-line no-console
  console.log(formatScore(label, score));
  const failures: string[] = [];
  if (score.precision < thresholds.precision) {
    failures.push(`precision ${score.precision.toFixed(3)} < ${thresholds.precision}`);
  }
  if (score.recall < thresholds.recall) {
    failures.push(`recall ${score.recall.toFixed(3)} < ${thresholds.recall}`);
  }
  if (score.f1 < thresholds.f1) {
    failures.push(`f1 ${score.f1.toFixed(3)} < ${thresholds.f1}`);
  }
  if (failures.length > 0) {
    throw new Error(`${label} below threshold — ${failures.join('; ')}`);
  }
}
