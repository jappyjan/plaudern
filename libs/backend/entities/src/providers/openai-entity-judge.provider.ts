import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { entityTypeSchema, type EntityType } from '@plaudern/contracts';
import type {
  EntityJudgeDecision,
  EntityJudgeInput,
  EntityJudgeProvider,
  EntityJudgeResult,
} from '../entity-judge.provider';
import { extractJsonObject } from './openai.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Judges whether two extracted entities are the same real-world thing (and, if
 * so, the correct type + which to keep) via an OpenAI-compatible
 * `/chat/completions` endpoint. Configured through ENTITY_JUDGE_* env vars, each
 * falling back to the ENTITY_EXTRACTION_* equivalent — so wherever entity
 * extraction already runs (DeepSeek by default, or a local Ollama), judging
 * works with zero extra setup.
 *
 * Only the two entities' names/types/aliases (+ optional web snippets) are sent
 * — never transcripts or audio.
 */
@Injectable()
export class OpenAiEntityJudgeProvider implements EntityJudgeProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiEntityJudgeProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    const inherit = (key: string, fallback: string) =>
      config.get<string>(`ENTITY_JUDGE_${key}`) ??
      config.get<string>(`ENTITY_EXTRACTION_${key}`, fallback);
    this.baseUrl = inherit('BASE_URL', 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    this.apiKey = inherit('API_KEY', '');
    this.model = inherit('MODEL', 'deepseek-chat');
    this.timeoutMs = Number(inherit('TIMEOUT_MS', String(60_000)));
    this.explicitlyEnabled = inherit('ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async judge(input: EntityJudgeInput): Promise<EntityJudgeResult> {
    if (!this.enabled) {
      throw new Error(
        'entity judging is disabled — set ENTITY_JUDGE_API_KEY / ENTITY_EXTRACTION_API_KEY ' +
          '(cloud) or ENTITY_JUDGE_ENABLED=true (local) to enable it',
      );
    }

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
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: buildJudgePrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`entity judge request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const decision = parseJudgeResponse(content, input);
      return { decision, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const JUDGE_SYSTEM_PROMPT = [
  'You de-duplicate a knowledge graph for a personal note-taking app. Two entities were',
  'extracted from voice recordings and may be the SAME real-world thing recorded under',
  'different types or spellings (e.g. a company recorded once as an "organization" and once',
  'as a "product").',
  `Valid entity types: ${entityTypeSchema.options.join(', ')}.`,
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "sameThing": <boolean>, "recommendedType": <one valid type>,',
  '    "survivor": "subject" | "candidate", "confidence": <0..1>, "rationale": <short string> }',
  '',
  'Guidance:',
  '- Decide sameThing=true only when they clearly denote the same real-world entity. Names may',
  '  differ by spelling, transliteration, abbreviation or legal suffix ("Foo" / "Foo GmbH").',
  '- When sameThing, pick the single most accurate type for the real thing, and pick the survivor',
  '  whose name/type best represents it. When unsure of the type, prefer the more specific one.',
  '- Prefer sameThing=false when uncertain; a wrong merge is worse than a missed one.',
  '- Any provided web context is a hint, not ground truth.',
].join('\n');

/** Serialize the pair (and any web context) for the model. */
export function buildJudgePrompt(input: EntityJudgeInput): string {
  const lines: string[] = [];
  const side = (label: string, s: EntityJudgeInput['subject']) => {
    lines.push(`${label}:`);
    lines.push(`- name: ${s.name}`);
    lines.push(`- type: ${s.type}`);
    if (s.aliases.length > 0) lines.push(`- also known as: ${s.aliases.join(', ')}`);
  };
  side('Subject entity', input.subject);
  lines.push('');
  side('Candidate entity', input.candidate);
  if (input.webSnippets && input.webSnippets.length > 0) {
    lines.push('', 'Web context:');
    for (const snippet of input.webSnippets) lines.push(`- ${snippet}`);
  }
  lines.push('', 'Are these the same real-world thing? Respond with the JSON object only.');
  return lines.join('\n');
}

/**
 * Parse the model's verdict defensively: tolerate fences/prose, clamp the
 * confidence, coerce an unknown `survivor` to "subject", and fall back to the
 * survivor's own current type when `recommendedType` is missing or invalid — the
 * model must not invent a type outside the enum.
 */
export function parseJudgeResponse(content: string, input: EntityJudgeInput): EntityJudgeDecision {
  const json = extractJsonObject(content, 'entity judge') as Record<string, unknown>;

  const sameThing = json.sameThing === true;
  const survivor: 'subject' | 'candidate' = json.survivor === 'candidate' ? 'candidate' : 'subject';
  const survivorType = survivor === 'candidate' ? input.candidate.type : input.subject.type;

  const parsedType = entityTypeSchema.safeParse(json.recommendedType);
  const recommendedType: EntityType = parsedType.success ? parsedType.data : survivorType;

  const rawConfidence = json.confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0;

  const rawRationale = json.rationale;
  const rationale = typeof rawRationale === 'string' ? rawRationale.slice(0, 500) : '';

  return { sameThing, recommendedType, survivor, confidence, rationale };
}
