/**
 * Structural citation enforcement (JJ-37, VISION §6 anti-hallucination).
 *
 * The model is told to cite the numbered sources it was given as `[n]`
 * markers, but prompts are hope, not proof — so the server post-processes
 * every answer:
 *
 * 1. markers referencing sources that were never provided are STRIPPED (the
 *    model cannot invent evidence),
 * 2. the surviving markers are renumbered 1..k in order of first appearance
 *    (so the UI shows a dense citation list),
 * 3. substantive CLAUSES without any citation are counted — the caller
 *    downgrades such answers to low confidence ("I think — check the source"),
 * 4. an answer left with NO valid citation at all is rejected outright — the
 *    caller replaces it with an explicit "I can't back this up" response
 *    instead of presenting an uncited claim as memory.
 *
 * The identifier-guarded marker regexes and the clause-level coverage check are
 * SHARED across every prose-generating kind — they live in `@plaudern/citations`
 * so chat, journal, and topic documents enforce one positioning contract. Only
 * the chat-specific renumbering lives here; unlike the journal/topic-doc
 * sanitizers, chat renumbers survivors densely.
 */

import { MARKER_RE, MARKER_RUN_RE, analyzeCitationCoverage } from '@plaudern/citations';

export interface EnforcedAnswer {
  /** Answer text with invalid markers stripped and valid ones renumbered 1..k. */
  content: string;
  /**
   * The ORIGINAL marker numbers kept, in order of first appearance; index i
   * corresponds to renumbered marker i+1.
   */
  usedMarkers: number[];
  /** Substantive clauses that carry no citation (→ low confidence). */
  uncitedClaimCount: number;
}

/**
 * Enforce the citation contract on a model answer. `validMarkers` is the set
 * of source numbers that were actually provided to the model.
 */
export function enforceCitations(answer: string, validMarkers: Set<number>): EnforcedAnswer {
  // Pass 1: within citation-position runs only, drop invalid markers and
  // collect valid ones in order of appearance. Identifier-adjacent brackets
  // (`data[3]`, `foo[15]`) are outside any run and stay untouched.
  const usedMarkers: number[] = [];
  const stripped = answer.replace(MARKER_RUN_RE, (run) =>
    run.replace(MARKER_RE, (whole, digits: string) => {
      const n = Number(digits);
      if (!validMarkers.has(n)) return '';
      if (!usedMarkers.includes(n)) usedMarkers.push(n);
      return whole;
    }),
  );

  // Pass 2: renumber the survivors 1..k by first appearance.
  const renumber = new Map(usedMarkers.map((orig, index) => [orig, index + 1]));
  const content = stripped
    .replace(MARKER_RUN_RE, (run) =>
      run.replace(MARKER_RE, (_whole, digits: string) => `[${renumber.get(Number(digits))}]`),
    )
    // Tidy the holes stripping can leave behind: "  ", " .", " ,".
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();

  return { content, usedMarkers, uncitedClaimCount: countUncitedClaims(content) };
}

/**
 * Count substantive CLAUSES that carry no `[n]` marker. Delegates to the shared
 * clause-level coverage analyzer (JJ-68) with chat's STRICT contract: any single
 * uncited clause is enough to hedge the answer. Clause-level splitting is what
 * catches the "Anna is pregnant. He quit his job. She moved to Berlin. Yes [1]."
 * case the old sentence-length heuristic served at HIGH confidence.
 */
export function countUncitedClaims(content: string): number {
  return analyzeCitationCoverage(content, { strictUncited: true }).uncitedClaims;
}
