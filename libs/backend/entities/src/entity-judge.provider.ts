import type { EntityType } from '@plaudern/contracts';

/**
 * Provider seam for LLM-backed duplicate judging: given two extracted entities
 * (and, optionally, a few web-research snippets), decide whether they are the
 * same real-world thing, which type is correct, and which one to keep. Mirrors
 * the entity/relation/contact-resolution provider seams so tests can inject
 * fakes and future providers can slot in. Only names/types (+ optional snippets)
 * are ever sent — never transcripts or audio.
 */
export const ENTITY_JUDGE_PROVIDER = 'ENTITY_JUDGE_PROVIDER';

/** One side of the pair as presented to the model. */
export interface EntityJudgeSide {
  name: string;
  type: EntityType;
  aliases: string[];
}

export interface EntityJudgeInput {
  subject: EntityJudgeSide;
  candidate: EntityJudgeSide;
  /** Optional web-research context; each string is a short grounded snippet. */
  webSnippets?: string[];
}

/** The model's verdict for one pair. */
export interface EntityJudgeDecision {
  /** Whether the two are the same real-world thing. */
  sameThing: boolean;
  /** The type the surviving entity should carry (validated against the enum). */
  recommendedType: EntityType;
  /** Which side to keep as the survivor. */
  survivor: 'subject' | 'candidate';
  confidence: number;
  rationale: string;
}

export interface EntityJudgeResult {
  decision: EntityJudgeDecision;
  model: string;
  raw?: unknown;
}

export interface EntityJudgeProvider {
  readonly id: string;
  readonly enabled: boolean;
  judge(input: EntityJudgeInput): Promise<EntityJudgeResult>;
}

/** Accept the judge's "same thing" verdict at or above this confidence. */
export const JUDGE_ACCEPT_CONFIDENCE = 0.7;
