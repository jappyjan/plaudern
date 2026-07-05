import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WEB_RESEARCH_FETCH,
  type WebResearchFetch,
  type WebResearchInput,
  type WebResearchProvider,
  type WebResearchResult,
} from '../web-research.provider';
import { extractJsonObject } from './openai.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
}

/** Abort a research call that hasn't answered within this window. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Ignore oversized responses (grounded answers are small). */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Never send more than a few short snippets downstream. */
const MAX_SNIPPETS = 5;

/**
 * OPT-IN web research via an OpenAI-compatible, web-grounded `/chat/completions`
 * endpoint (e.g. Perplexity or an OpenRouter web model). Configured through
 * WEB_RESEARCH_* env vars and only ever selected when WEB_RESEARCH_ENABLED=true.
 *
 * Privacy: only the entity name, type and a short context hint are sent — never
 * transcripts, other entities, or audio.
 */
@Injectable()
export class OpenAiWebResearchProvider implements WebResearchProvider {
  private readonly logger = new Logger(OpenAiWebResearchProvider.name);
  private readonly masterEnabled: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    @Inject(WEB_RESEARCH_FETCH) private readonly fetchImpl: WebResearchFetch,
  ) {
    this.masterEnabled = config.get<string>('WEB_RESEARCH_ENABLED', 'false') === 'true';
    this.baseUrl = config.get<string>('WEB_RESEARCH_BASE_URL', '').replace(/\/+$/, '');
    this.apiKey = config.get<string>('WEB_RESEARCH_API_KEY', '');
    this.model = config.get<string>('WEB_RESEARCH_MODEL', '');
    this.timeoutMs = Number(config.get<string>('WEB_RESEARCH_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)));
  }

  get enabled(): boolean {
    // Requires the master switch plus a configured endpoint + model.
    return this.masterEnabled && this.baseUrl.length > 0 && this.model.length > 0;
  }

  async research(input: WebResearchInput): Promise<WebResearchResult> {
    if (!this.enabled) return { snippets: [], usedWeb: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: WEB_RESEARCH_SYSTEM_PROMPT },
            { role: 'user', content: buildResearchPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`web research request failed: ${res.status}`);
        return { snippets: [], usedWeb: false };
      }
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        this.logger.warn('web research response too large; ignoring');
        return { snippets: [], usedWeb: false };
      }
      const json = JSON.parse(text) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const snippets = parseResearchSnippets(content);
      return { snippets, usedWeb: snippets.length > 0 };
    } catch (err) {
      this.logger.warn(`web research failed: ${(err as Error).message}`);
      return { snippets: [], usedWeb: false };
    } finally {
      clearTimeout(timer);
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
