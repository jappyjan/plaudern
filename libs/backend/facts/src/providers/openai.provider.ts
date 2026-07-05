import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import { extractedFactSchema, type ExtractedFact } from '@plaudern/contracts';
import type {
  FactExtractionInput,
  FactExtractionProvider,
  FactExtractionResult,
} from '../facts.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts durable personal facts about people via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) — the
 * cheapest capable option — but any provider exposing the OpenAI schema works by
 * overriding FACTS_BASE_URL/MODEL, including a **local Ollama** server
 * (`FACTS_BASE_URL=http://localhost:11434/v1`, `FACTS_MODEL=llama3.1`,
 * `FACTS_ENABLED=true`) — the local-model tier that keeps sensitive transcripts
 * off the network, mirroring summarization/entities/topics/tasks.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiFactExtractionProvider implements FactExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiFactExtractionProvider.name);
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
      .get<string>('FACTS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('FACTS_API_KEY', '');
    this.model = config.get<string>('FACTS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('FACTS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) have no key
    // to set, so they opt in explicitly via FACTS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('FACTS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: FactExtractionInput): Promise<FactExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'personal-fact extraction is disabled — set FACTS_API_KEY (cloud endpoints) or ' +
          'FACTS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Most local servers (Ollama, llama.cpp) ignore auth entirely; only send
      // the header when a key was actually configured.
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const endpoint = `${this.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
      });
      // Audit the exact bytes leaving the box before they leave (JJ-42).
      await this.audit.record({ provider: this.id, endpoint, payload: body });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`personal-fact extraction request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const facts = parseFactsResponse(content);
      return { facts, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract durable PERSONAL FACTS about the people in the note owner\'s life from a',
  'transcribed audio recording for a note-taking app. A personal fact is a lasting piece',
  'of knowledge about a specific person — a relationship, a preference, an allergy, a',
  'birthday, a life event, a gift idea someone mentioned, where they work or live.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "facts": [ {',
  '      "person": <the person the fact is ABOUT, by name>,',
  '      "attribute": <short key naming what the fact is about, e.g. "birthday",',
  '                    "allergy", "schooling", "job", "gift idea", "preference">,',
  '      "value": <the fact itself, a short phrase>,',
  '      "exclusive": <true|false — see below>,',
  '      "quote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- "person" is who the fact is ABOUT (not who is speaking) — use their name. If you',
  '  cannot confidently name the subject, OMIT the fact (prefer precision over recall).',
  '- "attribute" groups related facts about a person. Keep it short and reusable.',
  '- "exclusive" says whether the attribute holds ONE current value per person:',
  '    exclusive=true  → a newer statement REPLACES the older one: birthday,',
  '                      current city, employer, relationship status, school year.',
  '    exclusive=false → multiple values hold AT ONCE (accumulate): allergy,',
  '                      gift idea, hobby, child, preference, dietary restriction.',
  '  When unsure, use false — accumulating is safer than replacing.',
  '- Extract only DURABLE facts about people; ignore transient events, the owner\'s own',
  '  todo items, hypotheticals, and idle chatter.',
  '- Do NOT invent facts. If there are none, return { "facts": [] }.',
].join('\n');

/** Build the user message: metadata + known-contact hints + the text. */
export function buildUserPrompt(input: FactExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) parts.push(`Recording metadata — ${meta.join(', ')}.`, '');

  if (input.knownPeople.length > 0) {
    parts.push(
      'Known contacts (prefer these spellings when a fact is about one of them):',
      input.knownPeople.map((p) => `- ${p.name}`).join('\n'),
      '',
    );
  }

  parts.push('Text:', '"""', input.text.trim(), '"""');
  return parts.join('\n');
}

/** Bounds on untrusted LLM output — matched to the extractedFactSchema limits. */
export const MAX_PARSED_FACTS = 50;
const MAX_PERSON_CHARS = 200;
const MAX_ATTRIBUTE_CHARS = 80;
const MAX_VALUE_CHARS = 500;
const MAX_QUOTE_CHARS = 1_000;

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, coerce/truncate loose fields, validate each entry through
 * the contract schema, drop malformed entries rather than throwing, and always
 * return a (possibly empty) array.
 */
export function parseFactsResponse(content: string): ExtractedFact[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { facts?: unknown }).facts)
    ? (json as { facts: unknown[] }).facts
    : [];
  const facts: ExtractedFact[] = [];
  for (const raw of rawList) {
    if (facts.length >= MAX_PARSED_FACTS) break;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const parsed = extractedFactSchema.safeParse({
      person: typeof candidate.person === 'string' ? candidate.person.trim().slice(0, MAX_PERSON_CHARS) : '',
      attribute:
        typeof candidate.attribute === 'string'
          ? candidate.attribute.trim().slice(0, MAX_ATTRIBUTE_CHARS)
          : candidate.attribute,
      value:
        typeof candidate.value === 'string'
          ? candidate.value.trim().slice(0, MAX_VALUE_CHARS)
          : candidate.value,
      // Only an explicit true supersedes; anything else (absent, "true",
      // garbage) accumulates — mislabeling must degrade to extra visible
      // facts, never to hidden data.
      exclusive: candidate.exclusive === true,
      quote:
        typeof candidate.quote === 'string' ? candidate.quote.trim().slice(0, MAX_QUOTE_CHARS) : null,
    });
    if (parsed.success && parsed.data.attribute.length > 0 && parsed.data.value.length > 0) {
      facts.push(parsed.data);
    }
  }
  return facts;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no facts) rather than throwing when nothing
 * parses, so a chatty model can't fail the whole job.
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
