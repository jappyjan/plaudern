import { Injectable, Logger } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import {
  type WebResearchInput,
  type WebResearchProvider,
  type WebResearchResult,
} from '../web-research.provider';
import { extractJsonObject } from './openai.provider';

/** Never send more than a few short snippets downstream. */
const MAX_SNIPPETS = 5;

/**
 * OPT-IN web research via an OpenAI-compatible, web-grounded `/chat/completions`
 * endpoint (e.g. Perplexity or an OpenRouter web model). The endpoint/model come
 * from the user's DB-backed AI config (`@plaudern/ai-config`, capability
 * `web_research`); callers gate on `aiConfig.isEnabled(userId, 'web_research')`
 * before invoking, so it stays opt-in.
 *
 * Privacy: only the entity name, type and a short context hint are sent — never
 * transcripts, other entities, or audio.
 */
@Injectable()
export class OpenAiWebResearchProvider implements WebResearchProvider {
  private readonly logger = new Logger(OpenAiWebResearchProvider.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async research(userId: string, input: WebResearchInput): Promise<WebResearchResult> {
    const config = await this.aiConfig.resolve(userId, 'web_research');
    if (!config) return { snippets: [], usedWeb: false };

    try {
      const response = await this.chat.chat(config, {
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: WEB_RESEARCH_SYSTEM_PROMPT },
          { role: 'user', content: buildResearchPrompt(input) },
        ],
      });
      const snippets = parseResearchSnippets(this.chat.contentOf(response));
      return { snippets, usedWeb: snippets.length > 0 };
    } catch (err) {
      this.logger.warn(`web research failed: ${(err as Error).message}`);
      return { snippets: [], usedWeb: false };
    }
  }
}

export const WEB_RESEARCH_SYSTEM_PROMPT = [
  'You research a named entity on the web to help classify it. Return a single JSON object',
  '  { "snippets": [<short factual string>, ...] }',
  'with at most a handful of concise, factual snippets describing what the entity is (e.g.',
  'whether it is a company/organization or a product, and what it does). No prose outside the',
  'JSON. If you find nothing reliable, return an empty array.',
].join('\n');

/** Only the name, type and a short hint leave — nothing sensitive. */
export function buildResearchPrompt(input: WebResearchInput): string {
  const lines = [`Entity name: ${input.name}`, `Extracted as type: ${input.type}`];
  if (input.context) lines.push(`Context: ${input.context}`);
  lines.push('', 'What is this, really? Respond with the JSON object only.');
  return lines.join('\n');
}

/** Parse `{ snippets: string[] }` defensively; cap the count and length. */
export function parseResearchSnippets(content: string): string[] {
  const json = extractJsonObject(content, 'web research') as { snippets?: unknown };
  if (!Array.isArray(json.snippets)) return [];
  return json.snippets
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, MAX_SNIPPETS)
    .map((s) => s.trim().slice(0, 500));
}
