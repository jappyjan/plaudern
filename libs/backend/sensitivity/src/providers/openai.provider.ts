import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import { sensitivityCategorySchema, sensitivityTierSchema } from '@plaudern/contracts';
import type {
  SentinelClassifyInput,
  SentinelFinding,
  SentinelLlmProvider,
  SentinelLlmResult,
} from '../sentinel.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * OpenAI-compatible `/chat/completions` implementation of the optional sentinel
 * LLM classifier (JJ-21), mirroring the reminders/decisions providers. Disabled
 * unless SENTINEL_LLM_API_KEY is set (cloud) or SENTINEL_LLM_ENABLED=true
 * (keyless local endpoints such as Ollama). Point SENTINEL_LLM_BASE_URL at a
 * local server to keep raw transcripts off the network.
 */
@Injectable()
export class OpenAiSentinelProvider implements SentinelLlmProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiSentinelProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(
    config: ConfigService,
    private readonly audit: AiAuditRecorder,
  ) {
    this.baseUrl = config
      .get<string>('SENTINEL_LLM_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('SENTINEL_LLM_API_KEY', '');
    this.model = config.get<string>('SENTINEL_LLM_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('SENTINEL_LLM_TIMEOUT_MS', String(60_000)));
    this.explicitlyEnabled = config.get<string>('SENTINEL_LLM_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async classify(input: SentinelClassifyInput): Promise<SentinelLlmResult> {
    if (!this.enabled) {
      throw new Error(
        'sentinel LLM classifier is disabled — set SENTINEL_LLM_API_KEY (cloud) or ' +
          'SENTINEL_LLM_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const endpoint = `${this.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SENTINEL_SYSTEM_PROMPT },
          { role: 'user', content: buildSentinelPrompt(input) },
        ],
      });
      // Audit the exact bytes leaving the box before they leave (JJ-42/JJ-81).
      // The sentinel classifier is itself an external LLM call; the {user, item}
      // attribution is read from the AsyncLocalStorage context the processor set.
      await this.audit.record({ provider: this.id, endpoint, payload: body });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`sentinel classification failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const { tier, findings } = parseSentinelResponse(content);
      return { tier, findings, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SENTINEL_SYSTEM_PROMPT = [
  'You are a privacy SENTINEL for a personal note-taking app. Read a transcript',
  'and flag genuinely SENSITIVE content that should be kept off external cloud',
  'services and masked by default. Focus on nuance the app\'s regexes miss:',
  '- HEALTH details (diagnoses, medications, mental-health, conditions).',
  '- OTHER PEOPLE\'S SECRETS confided in the recording (someone else\'s affair,',
  '  addiction, legal trouble, finances).',
  '- Any other clearly private/secret material.',
  '',
  'Respond with a single JSON object and nothing else:',
  '  { "tier": "normal" | "sensitive" | "secret",',
  '    "findings": [ { "category": "health" | "other_secret", ',
  '                    "quote": <the short verbatim transcript span> } ] }',
  '',
  'Rules:',
  '- Use "normal" when nothing sensitive is present (findings: []).',
  '- Use "sensitive" for health/other-secret material; "secret" only for',
  '  credentials/passwords stated in the text.',
  '- Every quote MUST be copied verbatim from the transcript.',
  '- Prefer precision: do not flag ordinary personal chatter.',
].join('\n');

export function buildSentinelPrompt(input: SentinelClassifyInput): string {
  const parts: string[] = [];
  if (input.language) parts.push(`Language: ${input.language}.`, '');
  parts.push('Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/** Parse the classifier reply defensively; malformed output ⇒ normal, no findings. */
export function parseSentinelResponse(content: string): {
  tier: SentinelLlmResult['tier'];
  findings: SentinelFinding[];
} {
  const json = extractJsonObject(content);
  const tierParse = sensitivityTierSchema.safeParse((json as { tier?: unknown }).tier);
  const tier = tierParse.success ? tierParse.data : 'normal';
  const rawFindings = Array.isArray((json as { findings?: unknown }).findings)
    ? (json as { findings: unknown[] }).findings
    : [];
  const findings: SentinelFinding[] = [];
  for (const raw of rawFindings) {
    if (!raw || typeof raw !== 'object') continue;
    const category = sensitivityCategorySchema.safeParse((raw as { category?: unknown }).category);
    const quote = (raw as { quote?: unknown }).quote;
    if (category.success && typeof quote === 'string' && quote.trim().length > 0) {
      findings.push({ category: category.data, quote });
    }
  }
  return { tier, findings };
}

export function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [unfenced, trimmed]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}
