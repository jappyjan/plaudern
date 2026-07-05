/**
 * Verification pass provider (JJ-20). A verification is a NEW generation kind
 * conceptually — an LLM-judge that re-checks the HIGH-STAKES fields in a
 * generated answer (dates, amounts, names) against the raw source passages the
 * answer cited. It catches the confident-but-wrong extraction that the
 * structural citation check can't: a marker can be present and still point at a
 * passage that says something different.
 *
 * Like every LLM kind in this codebase it ships DISABLED until a key is set
 * (VERIFICATION_API_KEY, falling back to the SUMMARIZATION_* tier); callers MUST
 * check {@link CitationVerifier.enabled} before invoking and degrade gracefully
 * when it is off (skip verify, keep the dependency-free coverage check).
 */

/** One field the verifier judged, with its verdict. */
export interface VerifiedField {
  /** The high-stakes value as written in the answer (e.g. "900 euros", "12 May"). */
  value: string;
  /** What kind of field it is, for display/telemetry. */
  kind: 'date' | 'amount' | 'name' | 'other';
  /** Whether the cited passages actually support the value as written. */
  supported: boolean;
}

export interface VerificationInput {
  /** The generated answer/prose to check (with its inline `[n]` markers). */
  answer: string;
  /**
   * The source passages the answer rests on — the raw text behind each cited
   * marker. The judge checks the answer's high-stakes fields against THESE only.
   */
  passages: string[];
}

export interface VerificationResult {
  /** Every high-stakes field the judge inspected. */
  fields: VerifiedField[];
  /** Concrete model that produced the verdict, for provenance. */
  model?: string;
  raw?: unknown;
}

export interface CitationVerifier {
  readonly id: string;
  verify(userId: string, input: VerificationInput): Promise<VerificationResult>;
}

export const CITATION_VERIFIER = Symbol('CITATION_VERIFIER');
