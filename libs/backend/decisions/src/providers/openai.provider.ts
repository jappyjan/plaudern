import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractedDecisionSchema, type ExtractedDecision } from '@plaudern/contracts';
import type {
  DecisionExtractionInput,
  DecisionExtractionProvider,
  DecisionExtractionResult,
} from '../decisions.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts decisions via an OpenAI-compatible `/chat/completions` endpoint.
 * Defaults to DeepSeek (`deepseek-chat`) — the cheapest capable option — but
 * any provider exposing the OpenAI schema works by overriding
 * DECISIONS_BASE_URL/MODEL, including a **local Ollama** server
 * (`DECISIONS_BASE_URL=http://localhost:11434/v1`) — the local-model tier that
 * keeps sensitive transcripts off the network, mirroring the questions and
 * topics extractors.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiDecisionExtractionProvider implements DecisionExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiDecisionExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('DECISIONS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('DECISIONS_API_KEY', '');
    this.model = config.get<string>('DECISIONS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('DECISIONS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) opt in
    // explicitly via DECISIONS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('DECISIONS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: DecisionExtractionInput): Promise<DecisionExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'decision extraction is disabled — set DECISIONS_API_KEY (cloud endpoints) or ' +
          'DECISIONS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Most local servers (Ollama, llama.cpp) ignore auth entirely; only send
      // the header when a key was actually configured.
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
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `decision extraction request failed: ${res.status} ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const decisions = parseDecisionsResponse(content);
      return { decisions, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract DECISIONS from a transcribed conversation for a note-taking app.',
  'A decision is a choice that was actually MADE or agreed to in the recording —',
  '"we decided to go with the cheaper option", "I\'ll switch banks", "we agreed to',
  'postpone the trip". A decision is a resolution, not a plan under debate.',
  '',
  'The transcript may be speaker-attributed with LABEL: prefixes (e.g. SPEAKER_00:).',
  'Use the speaker roster to name the participants involved in each decision.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "decisions": [ {',
  '      "decision": <the decision in a short phrase>,',
  '      "context": <the reasoning/why behind it, or null>,',
  '      "participants": <who was involved, e.g. "Anna and me", or "" if unknown>,',
  '      "confidence": <your confidence 0..1 that this is a real decision>,',
  '      "sourceQuote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- Only include decisions that were actually resolved — not open questions,',
  '  ideas floated, or options still being weighed. Prefer precision over recall.',
  '- context captures WHY the decision was made (the reasoning), when stated.',
  '- participants names the people who made or agreed to the decision; "" if unclear.',
  '- confidence is a number between 0 and 1; use lower values when unsure.',
  '- If there are no decisions, return { "decisions": [] }.',
].join('\n');

/** Build the user message: metadata + speaker roster + the transcript. */
export function buildUserPrompt(input: DecisionExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) parts.push(`Recording metadata — ${meta.join(', ')}.`, '');

  if (input.speakers.length > 0) {
    parts.push('Speakers:');
    for (const s of input.speakers) {
      parts.push(`- ${s.label}: ${s.displayName}`);
    }
    parts.push('');
  }

  parts.push('Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, validate each entry through the contract schema, drop
 * malformed entries rather than throwing, and always return a (possibly empty)
 * array.
 */
export function parseDecisionsResponse(content: string): ExtractedDecision[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { decisions?: unknown }).decisions)
    ? (json as { decisions: unknown[] }).decisions
    : [];
  const decisions: ExtractedDecision[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = extractedDecisionSchema.safeParse(raw);
    if (parsed.success) decisions.push(parsed.data);
  }
  return decisions;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no decisions) rather than throwing when
 * nothing parses, so a chatty model can't fail the whole job.
 */
export function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidates = [unfenced, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
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
