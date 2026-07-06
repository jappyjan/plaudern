import { Injectable } from '@nestjs/common';
import type {
  WebResearchInput,
  WebResearchProvider,
  WebResearchResult,
} from '../web-research.provider';

/**
 * A no-op web-research provider: does nothing and reaches no network. Kept as an
 * always-safe fallback binding for the WEB_RESEARCH_PROVIDER token; reconciliation
 * can call it unconditionally (it just no-ops).
 */
@Injectable()
export class DisabledWebResearchProvider implements WebResearchProvider {
  research(_userId: string, _input: WebResearchInput): Promise<WebResearchResult> {
    return Promise.resolve({ snippets: [], usedWeb: false });
  }
}
