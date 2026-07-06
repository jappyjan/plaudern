import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { entityTypeSchema, type EntityType } from '@plaudern/contracts';
import type {
  EntityJudgeDecision,
  EntityJudgeInput,
  EntityJudgeProvider,
  EntityJudgeResult,
} from '../entity-judge.provider';
import { extractJsonObject } from './openai.provider';

/**
 * Judges whether two extracted entities are the same real-world thing (and, if
 * so, the correct type + which to keep) via an OpenAI-compatible
 * `/chat/completions` endpoint. The endpoint/model come from the user's
 * DB-backed AI config (`@plaudern/ai-config`, capability `entity_judge`, which
 * inherits from `entity_extraction` when unset) — so wherever entity extraction
 * already runs, judging works with zero extra setup.
 *
 * Only the two entities' names/types/aliases (+ optional web snippets) are sent
 * — never transcripts or audio.
 */
@Injectable()
export class OpenAiEntityJudgeProvider implements EntityJudgeProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async judge(userId: string, input: EntityJudgeInput): Promise<EntityJudgeResult> {
    const config = await this.aiConfig.resolve(userId, 'entity_judge');
    if (!config) {
      throw new Error(
        'entity judging is not configured — assign a provider to the ' +
          'entity_judge capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: buildJudgePrompt(input) },
      ],
    });
    const decision = parseJudgeResponse(this.chat.contentOf(response), input);
    return { decision, model: response.model ?? config.model, raw: response };
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
