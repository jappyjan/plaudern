import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CitationVerifier,
  VerificationInput,
  VerificationResult,
  VerifiedField,
} from '../verification.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

const SYSTEM_PROMPT = [
  'You are a strict fact-checker for a memory-prosthesis app. You are given an',
  'ANSWER generated from a set of numbered SOURCE passages, and the SOURCES.',
  'Your ONLY job is to verify the HIGH-STAKES concrete details in the answer —',
  'dates, times, amounts/quantities/money, and proper names — against the',
  'SOURCES. Do not judge style, completeness, or anything else.',
  '',
  'For each high-stakes value that appears in the answer, decide whether the',
  'SOURCES actually support it AS WRITTEN. A value is NOT supported if the',
  'sources say something different, are silent about it, or only vaguely imply',
  'it. When in doubt, mark it unsupported — a wrong "fact" is worse than a',
  'flagged one.',
  '',
  'Respond with a single JSON object and nothing else:',
  '  {"fields": [{"value": "<verbatim high-stakes value from the answer>",',
  '               "kind": "date" | "amount" | "name" | "other",',
  '               "supported": true | false}, ...]}',
  'If the answer contains no high-stakes values, return {"fields": []}.',
].join('\n');

/**
 * LLM-judge verifier via an OpenAI-compatible `/chat/completions` endpoint.
 * Mirrors the other extractors (DeepSeek default, temp 0, JSON mode); the
 * VERIFICATION_* env falls back to the SUMMARIZATION_* tier so a deploy that
 * already summarizes gets verification for free. With neither key set the pass
 * ships DISABLED and callers skip it.
 */
@Injectable()
export class OpenAiCitationVerifier implements CitationVerifier {
  readonly id: string;
  private readonly logger = new Logger(OpenAiCitationVerifier.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    const fallbackBaseUrl = config.get<string>(
      'SUMMARIZATION_BASE_URL',
      'https://api.deepseek.com/v1',
    );
    this.baseUrl = config
      .get<string>('VERIFICATION_BASE_URL', fallbackBaseUrl)
      .replace(/\/+$/, '');
    this.apiKey =
      config.get<string>('VERIFICATION_API_KEY', '') ||
      config.get<string>('SUMMARIZATION_API_KEY', '');
    this.model = config.get<string>('VERIFICATION_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('VERIFICATION_TIMEOUT_MS', String(60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) opt in via
    // VERIFICATION_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('VERIFICATION_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async verify(input: VerificationInput): Promise<VerificationResult> {
    if (!this.enabled) {
      throw new Error(
        'citation verification is disabled — set VERIFICATION_API_KEY (or SUMMARIZATION_API_KEY, ' +
          'which it falls back to) for cloud endpoints, or VERIFICATION_ENABLED=true for keyless ' +
          'local endpoints such as Ollama',
      );
    }

    const sources = input.passages
      .map((passage, index) => `[${index + 1}] """${passage}"""`)
      .join('\n');
    const user = `SOURCES:\n${sources}\n\nANSWER:\n${input.answer}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`verification request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      return {
        fields: parseFields(content),
        model: json.model ?? this.model,
        raw: content,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse the judge's JSON reply defensively (mirrors the other providers). */
function parseFields(content: string): VerifiedField[] {
  const parsed = extractJsonObject(content);
  const raw = Array.isArray(parsed.fields) ? parsed.fields : [];
  const fields: VerifiedField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!value) continue;
    const kind = normalizeKind(record.kind);
    // Anything not explicitly true is treated as unsupported (fail closed).
    const supported = record.supported === true;
    fields.push({ value, kind, supported });
  }
  return fields;
}

function normalizeKind(value: unknown): VerifiedField['kind'] {
  return value === 'date' || value === 'amount' || value === 'name' ? value : 'other';
}

function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [unfenced, trimmed]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {
      /* try the next candidate */
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
