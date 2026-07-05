import { Inject, Injectable, Logger } from '@nestjs/common';
import { CITATION_VERIFIER, type CitationVerifier } from './verification.provider';

/** The outcome the generation paths act on. */
export interface VerificationOutcome {
  /** Whether the LLM-judge actually ran (false when disabled or it failed). */
  ran: boolean;
  /** High-stakes values the judge found unsupported by the cited sources. */
  unsupported: string[];
}

const SKIPPED: VerificationOutcome = { ran: false, unsupported: [] };

/**
 * Verification pass (JJ-20): re-checks the high-stakes fields (dates, amounts,
 * names) of a generated answer against the passages it cited, so a confident
 * but wrong extraction is caught even when its citation marker is structurally
 * valid.
 *
 * Best-effort and gated: if the verifier is disabled (no key) or errors, this
 * returns `ran: false` and the caller keeps whatever confidence the
 * dependency-free coverage check produced — verification only ever TIGHTENS
 * (downgrades) confidence, it never upgrades.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @Inject(CITATION_VERIFIER)
    private readonly verifier: CitationVerifier,
  ) {}

  /** Whether the verification pass is configured to run. */
  get enabled(): boolean {
    return this.verifier.enabled;
  }

  /**
   * Verify the answer's high-stakes fields against its cited passages. Returns
   * the values the judge could not back. Never throws — a verification failure
   * degrades to "not run" so it can never break the surrounding generation.
   */
  async verifyHighStakes(answer: string, passages: string[]): Promise<VerificationOutcome> {
    if (!this.verifier.enabled) return SKIPPED;
    const usable = passages.map((p) => p?.trim()).filter((p): p is string => !!p);
    if (usable.length === 0 || !answer.trim()) return SKIPPED;

    try {
      const result = await this.verifier.verify({ answer, passages: usable });
      const unsupported = result.fields.filter((f) => !f.supported).map((f) => f.value);
      return { ran: true, unsupported };
    } catch (cause) {
      this.logger.warn(`citation verification failed, skipping: ${String(cause)}`);
      return SKIPPED;
    }
  }
}
