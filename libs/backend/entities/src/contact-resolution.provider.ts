/**
 * Provider seam for LLM-backed entity↔contact identity resolution: given one
 * person entity plus the evidence dossier for each plausible contact, decide
 * which contact (if any) is the same real person. Mirrors the entity/relation
 * extraction provider seams so tests can inject fakes and future providers
 * can slot in.
 */

export const CONTACT_RESOLUTION_PROVIDER = 'CONTACT_RESOLUTION_PROVIDER';

/** One contact candidate as presented to the model. */
export interface ContactResolutionCandidate {
  voiceProfileId: string;
  name: string | null;
  /** Human-readable evidence lines (heuristic reasons + counts). */
  evidence: string[];
  /** Heuristic confidence in [0, 1] — the model may agree or overrule. */
  heuristicConfidence: number;
}

export interface ContactResolutionInput {
  entity: {
    id: string;
    name: string;
    aliases: string[];
    /** A few mention surface forms with recording dates, for context. */
    mentionExamples: string[];
  };
  candidates: ContactResolutionCandidate[];
}

/** The model's verdict for one entity. */
export interface ContactResolutionDecision {
  /** The matching contact, or null when none of the candidates is this person. */
  voiceProfileId: string | null;
  confidence: number;
  reason: string;
}

export interface ContactResolutionResult {
  decision: ContactResolutionDecision;
  model: string;
  raw?: unknown;
}

export interface ContactResolutionProvider {
  readonly id: string;
  resolve(userId: string, input: ContactResolutionInput): Promise<ContactResolutionResult>;
}
