import type { EntityType } from '@plaudern/contracts';

/**
 * Provider seam for OPT-IN web research used to help decide an entity's true
 * type/identity during duplicate reconciliation. Off by default. Privacy: only
 * the entity's name, type and a short context hint ever leave — never
 * transcripts, other entities, or audio.
 */
export const WEB_RESEARCH_PROVIDER = 'WEB_RESEARCH_PROVIDER';

/**
 * Injectable fetch so tests (and future proxies) can replace the network,
 * mirroring the web-clipper convention (WEB_SNAPSHOT_FETCH).
 */
export type WebResearchFetch = typeof fetch;
export const WEB_RESEARCH_FETCH = Symbol('WEB_RESEARCH_FETCH');

export interface WebResearchInput {
  name: string;
  type: EntityType;
  /** A short, non-sensitive hint (e.g. the other candidate's name/type). */
  context?: string;
}

export interface WebResearchResult {
  /** Short grounded snippets to feed the judge; empty when nothing was found. */
  snippets: string[];
  /** True only when research actually ran and produced snippets. */
  usedWeb: boolean;
}

export interface WebResearchProvider {
  research(userId: string, input: WebResearchInput): Promise<WebResearchResult>;
}
