import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { entityTypeSchema, isMeaningfulAlias, type ExtractedEntity } from '@plaudern/contracts';
import type {
  EntityExtractionInput,
  EntityExtractionProvider,
  EntityExtractionResult,
} from '../entities.provider';

/**
 * Extracts named entities via an OpenAI-compatible `/chat/completions`
 * endpoint. The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `entity_extraction`) — any provider
 * exposing the OpenAI schema works (DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp server, …), mirroring summarization so the same local-model
 * tier keeps sensitive transcripts off the network.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiEntityExtractionProvider implements EntityExtractionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async extract(
    userId: string,
    input: EntityExtractionInput,
  ): Promise<EntityExtractionResult> {
    const config = await this.aiConfig.resolve(userId, 'entity_extraction');
    if (!config) {
      throw new Error(
        'entity extraction is not configured — assign a provider to the ' +
          'entity_extraction capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    const entities = parseEntitiesResponse(this.chat.contentOf(response));
    return { entities, model: response.model ?? config.model, raw: response };
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
