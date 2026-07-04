import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TopicClassificationAssignment,
  TopicClassificationInput,
  TopicClassificationProvider,
  TopicClassificationResult,
} from '../topics.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Zero-shot topic/project classification via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) — the
 * cheapest capable option — but any provider exposing the OpenAI schema works
 * by overriding TOPICS_BASE_URL/MODEL, including a **local Ollama** server
 * (`TOPICS_BASE_URL=http://localhost:11434/v1`), the local-model tier that keeps
 * sensitive transcripts off the network. Only text is sent, never audio.
 */
@Injectable()
export class OpenAiTopicClassificationProvider implements TopicClassificationProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiTopicClassificationProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('TOPICS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('TOPICS_API_KEY', '');
    this.model = config.get<string>('TOPICS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('TOPICS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, ...) opt in
    // explicitly instead of configuring a throwaway key.
    this.explicitlyEnabled = config.get<string>('TOPICS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async classify(input: TopicClassificationInput): Promise<TopicClassificationResult> {
    if (!this.enabled) {
      throw new Error(
        'topic classification is disabled — set TOPICS_API_KEY (cloud endpoints) or ' +
          'TOPICS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
        throw new Error(`topic classification request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const assignments = parseClassificationResponse(content, input.topics.map((t) => t.id));
      return { assignments, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  "You tag a note against the user's topic/project taxonomy for a note-taking app.",
  'Always respond with a single JSON object and nothing else, with the key:',
  '  "assignments": an array of { "id": <topic id from the list>, "confidence": <number 0..1> }.',
  '',
  'Rules:',
  '- Only assign a topic when the note genuinely relates to it; precision over recall.',
  '- Use ONLY the ids from the provided taxonomy; never invent an id.',
  '- A note may match several topics, exactly one, or none — return an empty array when nothing fits.',
  '- confidence reflects how sure you are the topic applies (1 = certain, 0 = not at all).',
  '- Do not add commentary; return only the JSON object.',
].join('\n');

/** Build the user message: the taxonomy menu + the note content. */
export function buildUserPrompt(input: TopicClassificationInput): string {
  const parts: string[] = [];

  parts.push('Taxonomy (assign any that apply, by id):');
  for (const topic of input.topics) {
    const description = topic.description?.trim();
    parts.push(`- id: ${topic.id} | ${topic.name}${description ? ` — ${description}` : ''}`);
  }

  if (input.language) {
    parts.push('', `Note language: ${input.language}.`);
  }

  parts.push('', 'Note:', '"""', input.content.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping,
 * discard ids outside the taxonomy, clamp confidence into [0, 1], and dedupe on
 * topic id (keeping the highest confidence). Returns an empty array rather than
 * throwing when the reply carries no usable assignments.
 */
export function parseClassificationResponse(
  content: string,
  validTopicIds: string[],
): TopicClassificationAssignment[] {
  const valid = new Set(validTopicIds);
  const json = extractJsonObject(content);
  const raw = Array.isArray(json.assignments) ? json.assignments : [];

  const byId = new Map<string, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id || !valid.has(id)) continue;
    const confidence = clamp01(toNumber(record.confidence));
    const existing = byId.get(id);
    if (existing === undefined || confidence > existing) byId.set(id, confidence);
  }

  return [...byId.entries()].map(([topicId, confidence]) => ({ topicId, confidence }));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Missing/invalid confidence is treated as a firm assignment.
  return 1;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function extractJsonObject(content: string): Record<string, unknown> {
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
  // Last resort: grab the outermost {...} span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  // No parseable JSON — treat as "nothing assigned" rather than failing the job.
  return {};
}
