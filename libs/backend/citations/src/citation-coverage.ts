/**
 * Shared structural-citation utilities (JJ-20, VISION §6 anti-hallucination).
 *
 * A memory prosthesis that confabulates is worse than none, so every generated
 * claim in a brief/answer/living-document must carry a citation to a source.
 * The canonical marker-positioning contract and the clause-level coverage check
 * live HERE and are reused by every prose-generating kind (memory chat, journal,
 * living topic documents) rather than copy-pasted per kind.
 *
 * Two orthogonal pieces:
 *  - the identifier-guarded `[n]` marker regexes (below), so real prose like
 *    `array[99]` or `arr[1][2]` is never mistaken for a citation;
 *  - {@link analyzeCitationCoverage}, which splits prose into clause-level
 *    claims, counts how many carry a citation, and derives a confidence signal
 *    ("high" vs "I think — check the source").
 *
 * This module is intentionally dependency-free (plain TS, no Nest/LLM) so any
 * read path can compute coverage cheaply and deterministically without an LLM.
 */

/**
 * A citation site is a RUN of one or more `[n]` groups (`[1]`, `[1][2]`) whose
 * first bracket is NOT immediately preceded by an identifier character or a
 * closing bracket/paren. That negative lookbehind keeps code/array indices out
 * of citation handling entirely: `data[3]` and `foo[15]` are left untouched,
 * while "… said so. [3]", a start-of-string "[1] …" and chained "… daily [1][2]."
 * remain citations. Matching whole runs (not single groups) is what keeps
 * `[1][2]` chains valid — the second group is preceded by `]`, which only
 * disqualifies it when the RUN starts inside an identifier (`arr[1][2]`).
 */
export const MARKER_RUN_RE = /(?<![A-Za-z0-9_\])])(?:\[\d{1,3}\])+/g;

/** A single `[n]` group INSIDE an already-validated run. */
export const MARKER_RE = /\[(\d{1,3})\]/g;

/** Position-aware single-marker test: does this text carry a citation marker? */
export const MARKER_AT_CITATION_POS_RE = /(?<![A-Za-z0-9_\])])\[\d{1,3}\]/;

/** Default: a claim-unit with fewer words than this is connective tissue. */
const DEFAULT_MIN_CLAIM_WORDS = 3;
/** Default: cited/total at or below this fraction → low confidence. */
const DEFAULT_COVERAGE_THRESHOLD = 0.5;

export interface CitationCoverageOptions {
  /**
   * Units with fewer whitespace-separated words than this (after markers are
   * removed) are treated as connective tissue, not claims ("Yes.", "In short:").
   * Default 3 — so a short but real claim like "Anna is pregnant" still counts.
   */
  minClaimWords?: number;
  /**
   * Ratio of cited to total substantive claims AT OR BELOW which the content is
   * flagged low-confidence. Default 0.5. Ignored when {@link strictUncited}.
   */
  coverageThreshold?: number;
  /**
   * When true, ANY uncited substantive claim forces low confidence — memory
   * chat's strict contract, where a single unsupported sentence is enough to
   * hedge the whole answer. When false (journal/topic-docs), the softer
   * coverage-ratio threshold is used so normally-cited prose isn't over-flagged.
   */
  strictUncited?: boolean;
}

export interface CitationCoverage {
  /** Substantive claims found (short/connective/question/hedged units excluded). */
  totalClaims: number;
  /** Substantive claims that carry at least one `[n]` marker. */
  citedClaims: number;
  /** Substantive claims with no citation → the confabulation risk. */
  uncitedClaims: number;
  /** citedClaims / totalClaims; 1 when there are no substantive claims. */
  coverageRatio: number;
  /** "low" means "I think — check the source". */
  confidence: 'high' | 'low';
}

/**
 * Abbreviations whose internal/trailing `.` must NOT be treated as a sentence
 * terminator (JJ-79). Without this guard, a properly-cited German sentence
 * using `z.B.` gets severed into an uncited fragment right after "z.B." and
 * gets spuriously downgraded to low confidence. Lower-cased for comparison.
 */
const ABBREVIATIONS = new Set(
  [
    'z.B.',
    'd.h.',
    'u.a.',
    'etc.',
    'i.e.',
    'e.g.',
    'usw.',
    'ca.',
    'Nr.',
    'vgl.',
    'bzw.',
    'z.T.',
    'o.Ä.',
    'ggf.',
    'inkl.',
    'Dr.',
    'Prof.',
  ].map((abbreviation) => abbreviation.toLowerCase()),
);

/** Characters allowed inside an abbreviation token: letters (incl. German umlauts/ß) plus internal `.` (e.g. "z.B."). */
const ABBREVIATION_TOKEN_CHAR_RE = /[A-Za-zÄÖÜäöüß.]/;

/**
 * Whether the `.` at `periodIndex` is a known abbreviation rather than a
 * sentence terminator: the letter/`.` token ending at this period (`z.B.`,
 * `etc.`, `Dr.`, …) is in the closed {@link ABBREVIATIONS} set.
 *
 * Deliberately NARROW — a closed set only. Earlier open-ended heuristics
 * (single-letter-before-dot, lowercase-next-token) were removed: they MERGE two
 * real sentences, and when the first is cited and the second is not, the
 * second's uncited-ness is hidden and strictUncited flips low→high — an
 * UNDER-hedge (an uncited claim served as high confidence), the one direction
 * JJ-68 / VISION §6 forbids. Over-splitting an unlisted abbreviation (e.g.
 * "J. Smith") is only an over-hedge, which JJ-79 explicitly accepts, so the
 * closed set is the safe floor.
 */
function isAbbreviationSplitPoint(content: string, periodIndex: number): boolean {
  let tokenStart = periodIndex;
  while (tokenStart > 0 && ABBREVIATION_TOKEN_CHAR_RE.test(content[tokenStart - 1])) {
    tokenStart -= 1;
  }
  const token = content.slice(tokenStart, periodIndex + 1);
  return ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * Split prose into clause-level claim units. Sentence terminators (`.!?`),
 * clause separators (`;:`), and newlines/bullets all break a unit — so
 * "Anna is pregnant. He quit his job." yields two units, not one, and each is
 * checked for its own citation. Language-agnostic on purpose (works for the
 * German transcripts too): no verb/POS heuristics, just punctuation — except
 * a `.` is NOT treated as a boundary when it ends a KNOWN abbreviation
 * (see {@link isAbbreviationSplitPoint}), so "z.B." and friends don't sever a
 * sentence into a spurious uncited claim (JJ-79).
 */
export function splitClaims(content: string): string[] {
  const units: string[] = [];
  let start = 0;
  const boundaryRe = /[.!?;:]\s+|\n+/g;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(content)) !== null) {
    const isPeriodBoundary = match[0][0] === '.';
    if (isPeriodBoundary && isAbbreviationSplitPoint(content, match.index)) {
      continue;
    }
    const end = match.index + match[0].length;
    units.push(content.slice(start, end));
    start = end;
  }
  units.push(content.slice(start));
  return units.map((unit) => unit.trim()).filter((unit) => unit.length > 0);
}

/**
 * Whether a clause-level unit is a substantive claim (something that asserts a
 * fact and therefore needs a citation). Questions, hedged non-answers
 * ("I couldn't find …"), and short connective fragments are NOT claims.
 */
export function isSubstantiveClaim(unit: string, minClaimWords: number): boolean {
  const trimmed = unit.trim();
  if (!trimmed) return false;
  // A question the model asks back is not a factual assertion.
  if (/[?？]\s*$/.test(trimmed)) return false;
  // "I couldn't find …" is exactly what we WANT said without a citation.
  if (isHedgedNonClaim(trimmed)) return false;
  // Count words with citation markers removed, so "Yes [1]" is one word, not two.
  const words = trimmed
    .replace(MARKER_RUN_RE, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= minClaimWords;
}

/** Whether a substantive claim carries a citation marker at a citation position. */
export function isCited(unit: string): boolean {
  return MARKER_AT_CITATION_POS_RE.test(unit);
}

/**
 * Analyze citation coverage of generated prose. Splits into clause-level claims,
 * counts cited vs uncited, and derives a confidence signal.
 */
export function analyzeCitationCoverage(
  content: string,
  options: CitationCoverageOptions = {},
): CitationCoverage {
  const minClaimWords = options.minClaimWords ?? DEFAULT_MIN_CLAIM_WORDS;
  const coverageThreshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;

  let totalClaims = 0;
  let citedClaims = 0;
  for (const unit of splitClaims(content)) {
    if (!isSubstantiveClaim(unit, minClaimWords)) continue;
    totalClaims += 1;
    if (isCited(unit)) citedClaims += 1;
  }

  const uncitedClaims = totalClaims - citedClaims;
  const coverageRatio = totalClaims === 0 ? 1 : citedClaims / totalClaims;

  let low = false;
  if (totalClaims > 0) {
    low = options.strictUncited
      ? uncitedClaims > 0
      : coverageRatio <= coverageThreshold;
  }

  return {
    totalClaims,
    citedClaims,
    uncitedClaims,
    coverageRatio,
    confidence: low ? 'low' : 'high',
  };
}

/** "I couldn't find …" / "Deine Aufnahmen erwähnen … nicht" style non-claims. */
export function isHedgedNonClaim(sentence: string): boolean {
  return /\b(could ?n[o']t find|no (mention|information|record)|not (mentioned|recorded|captured)|don'?t have|nicht (gefunden|erwähnt|aufgezeichnet)|keine (Erwähnung|Informationen?|Aufzeichnung))\b/i.test(
    sentence,
  );
}
