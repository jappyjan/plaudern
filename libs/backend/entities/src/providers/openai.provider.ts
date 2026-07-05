import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import { entityTypeSchema, isMeaningfulAlias, type ExtractedEntity } from '@plaudern/contracts';
import type {
  EntityExtractionInput,
  EntityExtractionProvider,
  EntityExtractionResult,
} from '../entities.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts named entities via an OpenAI-compatible `/chat/completions`
 * endpoint. Defaults to DeepSeek (`deepseek-chat`) — the cheapest capable
 * option — but any provider exposing the OpenAI schema works by overriding
 * ENTITY_EXTRACTION_BASE_URL/MODEL, including a **local Ollama** server
 * (`ENTITY_EXTRACTION_BASE_URL=http://localhost:11434/v1`,
 * `ENTITY_EXTRACTION_MODEL=llama3.1`) — the local-model tier that keeps
 * sensitive transcripts off the network, mirroring summarization.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiEntityExtractionProvider implements EntityExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiEntityExtractionProvider.name);
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
      .get<string>('ENTITY_EXTRACTION_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('ENTITY_EXTRACTION_API_KEY', '');
    this.model = config.get<string>('ENTITY_EXTRACTION_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(
      config.get<string>('ENTITY_EXTRACTION_TIMEOUT_MS', String(2 * 60_000)),
    );
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) have no
    // key to set, so they opt in explicitly via ENTITY_EXTRACTION_ENABLED=true.
    this.explicitlyEnabled =
      config.get<string>('ENTITY_EXTRACTION_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: EntityExtractionInput): Promise<EntityExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'entity extraction is disabled — set ENTITY_EXTRACTION_API_KEY (cloud endpoints) or ' +
          'ENTITY_EXTRACTION_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
        throw new Error(`entity extraction request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const entities = parseEntitiesResponse(content);
      return { entities, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract named entities from a transcribed audio recording for a note-taking app.',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "entities": [ { "type": <type>, "name": <string>, "mentions": [<string>, ...] }, ... ] }',
  '',
  'The "type" MUST be one of:',
  '  person             — a named individual (first/last name, nickname).',
  '  organization       — a company, institution, team, agency, or brand as an org.',
  '  place              — a location: city, country, address, venue, region.',
  '  product            — a named product, device, app, or service.',
  '  medication         — a drug or medication (with dosage if stated).',
  '  document_reference — a referenced document, contract, invoice, form or file.',
  '',
  'Rules:',
  '- "name" is the canonical/full form (e.g. resolve "she"/"the doctor" to the actual name ONLY if unambiguous; otherwise skip pronouns).',
  '- "mentions" lists the exact surface forms as they appear in the text; may be empty.',
  '- NEVER emit a pronoun, possessive, article, or generic role word as a "name" or in "mentions"',
  '  (e.g. "Sie", "ihr", "ihre", "der", "der Patient", "the doctor", "she", "them"). Only real',
  '  names/labels belong there — a mention like "Sie" or "der Patient" must be omitted entirely.',
  '- For person, organization, place, and product, extract ONLY when a specific name or brand is',
  '  stated; skip bare generic nouns with no name attached (e.g. a plain "Karte", "das Gerät", "die',
  '  Firma", "der Termin"). document_reference and medication may use their common noun (e.g.',
  '  "Krankschreibung", "Überweisung", "Ibuprofen").',
  '- Do NOT extract standalone dates, times, weekdays, or amounts/quantities — they are transient',
  '  values, not entities.',
  '- Deduplicate: one object per distinct real-world entity, collecting its variants into "mentions".',
  '- Extract only entities actually present; never invent. Prefer precision over recall.',
  '- If there are no entities, return { "entities": [] }.',
].join('\n');

/** Build the user message: metadata + the transcript to extract from. */
export function buildUserPrompt(input: EntityExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) {
    parts.push(`Recording metadata — ${meta.join(', ')}.`, '');
  }
  parts.push('Transcript:', '"""', input.text.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, drop malformed entries and unknown types rather than
 * throwing, and always return a (possibly empty) array.
 */
export function parseEntitiesResponse(content: string): ExtractedEntity[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { entities?: unknown }).entities)
    ? ((json as { entities: unknown[] }).entities)
    : [];
  const entities: ExtractedEntity[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const type = entityTypeSchema.safeParse(candidate.type);
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!type.success || !name) continue;
    // A pronoun/article/generic-noun name ("Sie", "der Patient") is never a real
    // entity — drop it rather than seed the registry with an unnamable row.
    if (!isMeaningfulAlias(name)) continue;
    const mentions = Array.isArray(candidate.mentions)
      ? candidate.mentions
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim())
          .filter(Boolean)
      : [];
    entities.push({ type: type.data, name, mentions });
  }
  return entities;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Shared with the relations provider.
 */
export function extractJsonObject(
  content: string,
  what = 'entity extraction',
): Record<string, unknown> {
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
  throw new Error(`${what} response was not valid JSON`);
}
