import { Injectable } from '@nestjs/common';
import type {
  WebResearchInput,
  WebResearchProvider,
  WebResearchResult,
} from '../web-research.provider';

/**
 * The default web-research provider: does nothing and reaches no network. Bound
 * whenever WEB_RESEARCH_ENABLED is not `true`, so the token always resolves and
 * reconciliation can call it unconditionally (it just no-ops).
 */
@Injectable()
export class DisabledWebResearchProvider implements WebResearchProvider {
  readonly enabled = false;

  research(_input: WebResearchInput): Promise<WebResearchResult> {
    return Promise.resolve({ snippets: [], usedWeb: false });
  }
}
