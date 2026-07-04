import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { relationTypeSchema, type ExtractedRelation } from '@plaudern/contracts';
import type {
  RelationExtractionInput,
  RelationExtractionProvider,
  RelationExtractionResult,
} from '../relations.provider';
import { extractJsonObject } from './openai.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts typed relations between an item's entities via an OpenAI-compatible
 * `/chat/completions` endpoint. Deliberately reuses the ENTITY_EXTRACTION_*
 * configuration (endpoint, key, model): relations only ever run downstream of
 * entities, so one knob configures the whole knowledge-graph tier — including
 * the local-Ollama option that keeps sensitive transcripts off the network.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiRelationExtractionProvider implements RelationExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiRelationExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('ENTITY_EXTRACTION_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('ENTITY_EXTRACTION_API_KEY', '');
    this.model = config.get<string>('ENTITY_EXTRACTION_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(
      config.get<string>('ENTITY_EXTRACTION_TIMEOUT_MS', String(2 * 60_000)),
    );
    // Same gating as entity extraction: cloud endpoints need a key, keyless
    // local servers (Ollama, llama.cpp, …) opt in via ENTITY_EXTRACTION_ENABLED.
    this.explicitlyEnabled =
      config.get<string>('ENTITY_EXTRACTION_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: RelationExtractionInput): Promise<RelationExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'relation extraction is disabled — set ENTITY_EXTRACTION_API_KEY (cloud endpoints) or ' +
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
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: RELATIONS_SYSTEM_PROMPT },
            { role: 'user', content: buildRelationsUserPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`relation extraction request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const relations = parseRelationsResponse(content);
      return { relations, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const RELATIONS_SYSTEM_PROMPT = [
  'You extract typed relations between known entities from a transcribed audio recording for a note-taking app.',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "relations": [ { "type": <type>, "source": <entity name>, "target": <entity name>, "label": <string, optional>, "confidence": <number 0..1, optional> }, ... ] }',
  '',
  'The "type" MUST be one of:',
  '  works_at       — source (a person) works at/for target (an organization).',
  '  located_in     — source is located in/at target (a place).',
  '  involved_in    — source takes part in target (a matter, case, project, event).',
  '  discussed_with — source discussed the matter at hand with target.',
  '  promised_to    — source promised something to target.',
  '  related_to     — a meaningful connection not covered by any other type.',
  '  part_of        — source is a part/member/component of target.',
  '  owns           — source owns or possesses target.',
  '',
  'Rules:',
  '- "source" and "target" MUST each be one of the known entities listed in the user message, spelled exactly as listed; never invent new entities.',
  '- Only extract relations the transcript actually states or clearly implies. Prefer precision over recall.',
  '- "label" may carry a short qualifier in the transcript\'s own words (e.g. "monthly rent", "since March").',
  '- "confidence" is your certainty from 0 to 1.',
  '- If there are no relations, return { "relations": [] }.',
].join('\n');

/** Build the user message: metadata + the legal endpoints + the transcript. */
export function buildRelationsUserPrompt(input: RelationExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) {
    parts.push(`Recording metadata — ${meta.join(', ')}.`, '');
  }
  parts.push('Known entities (the only legal relation endpoints):');
  for (const entity of input.entities) {
    parts.push(`- ${entity.name} (${entity.type})`);
  }
  parts.push('', 'Transcript:', '"""', input.text.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, drop malformed entries, unknown relation types and
 * out-of-range confidences rather than throwing, and always return a
 * (possibly empty) array. Endpoint validation against the item's actual
 * entities happens later, in EntityGraphService.ingest.
 */
export function parseRelationsResponse(content: string): ExtractedRelation[] {
  const json = extractJsonObject(content, 'relation extraction');
  const rawList = Array.isArray((json as { relations?: unknown }).relations)
    ? ((json as { relations: unknown[] }).relations)
    : [];
  const relations: ExtractedRelation[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const type = relationTypeSchema.safeParse(candidate.type);
    const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
    const target = typeof candidate.target === 'string' ? candidate.target.trim() : '';
    if (!type.success || !source || !target) continue;
    const label =
      typeof candidate.label === 'string' && candidate.label.trim()
        ? candidate.label.trim()
        : undefined;
    const confidence =
      typeof candidate.confidence === 'number' &&
      candidate.confidence >= 0 &&
      candidate.confidence <= 1
        ? candidate.confidence
        : undefined;
    relations.push({ type: type.data, source, target, label, confidence });
  }
  return relations;
}
