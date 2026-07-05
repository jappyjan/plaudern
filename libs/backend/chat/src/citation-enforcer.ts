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
 * 3. substantive sentences without any citation are counted — the caller
 *    downgrades such answers to low confidence ("I think — check the source"),
 * 4. an answer left with NO valid citation at all is rejected outright — the
 *    caller replaces it with an explicit "I can't back this up" response
 *    instead of presenting an uncited claim as memory.
 */

const MARKER_RE = /\[(\d{1,3})\]/g;

/** A sentence shorter than this is treated as connective tissue, not a claim. */
const MIN_CLAIM_LENGTH = 30;

export interface EnforcedAnswer {
  /** Answer text with invalid markers stripped and valid ones renumbered 1..k. */
  content: string;
  /**
   * The ORIGINAL marker numbers kept, in order of first appearance; index i
   * corresponds to renumbered marker i+1.
   */
  usedMarkers: number[];
  /** Substantive sentences that carry no citation (→ low confidence). */
  uncitedClaimCount: number;
}

/**
 * Enforce the citation contract on a model answer. `validMarkers` is the set
 * of source numbers that were actually provided to the model.
 */
export function enforceCitations(answer: string, validMarkers: Set<number>): EnforcedAnswer {
  // Pass 1: drop invalid markers, collect valid ones in order of appearance.
  const usedMarkers: number[] = [];
  const stripped = answer.replace(MARKER_RE, (whole, digits: string) => {
    const n = Number(digits);
    if (!validMarkers.has(n)) return '';
    if (!usedMarkers.includes(n)) usedMarkers.push(n);
    return whole;
  });

  // Pass 2: renumber the survivors 1..k by first appearance.
  const renumber = new Map(usedMarkers.map((orig, index) => [orig, index + 1]));
  const content = stripped
    .replace(MARKER_RE, (_whole, digits: string) => `[${renumber.get(Number(digits))}]`)
    // Tidy the holes stripping can leave behind: "  ", " .", " ,".
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();

  return { content, usedMarkers, uncitedClaimCount: countUncitedClaims(content) };
}

/**
 * Count substantive sentences that carry no `[n]` marker. Questions and short
 * connective fragments ("Yes.", "In short:") are not counted as claims, and
 * hedged non-answers ("I could not find …") are exactly what we WANT the model
 * to say without a citation, so they are exempt too.
 */
export function countUncitedClaims(content: string): number {
  const sentences = content.match(/[^.!?\n]+[.!?]?/g) ?? [];
  let count = 0;
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length < MIN_CLAIM_LENGTH) continue;
    if (sentence.endsWith('?')) continue;
    if (/\[\d{1,3}\]/.test(sentence)) continue;
    if (isHedgedNonClaim(sentence)) continue;
    count += 1;
  }
  return count;
}

/** "I couldn't find …" / "Deine Aufnahmen erwähnen … nicht" style non-claims. */
function isHedgedNonClaim(sentence: string): boolean {
  return /\b(could ?n[o']t find|no (mention|information|record)|not (mentioned|recorded|captured)|don'?t have|nicht (gefunden|erwähnt|aufgezeichnet)|keine (Erwähnung|Informationen?|Aufzeichnung))\b/i.test(
    sentence,
  );
}
