import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  TopicClassificationAssignment,
  TopicClassificationInput,
  TopicClassificationProvider,
  TopicClassificationResult,
} from '../topics.provider';

/**
 * Zero-shot topic/project classification via an OpenAI-compatible
 * `/chat/completions` endpoint. The endpoint/model come from the user's
 * DB-backed AI config (`@plaudern/ai-config`, capability `topics`) — any
 * provider exposing the OpenAI schema works (DeepSeek, OpenAI, OpenRouter, a
 * local Ollama/llama.cpp gateway, …). Only text is sent, never audio.
 */
@Injectable()
export class OpenAiTopicClassificationProvider implements TopicClassificationProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async classify(
    userId: string,
    input: TopicClassificationInput,
  ): Promise<TopicClassificationResult> {
    const config = await this.aiConfig.resolve(userId, 'topics');
    if (!config) {
      throw new Error(
        'topic classification is not configured — add an AI provider and assign it to the ' +
          'topics capability in Settings → AI',
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
    const assignments = parseClassificationResponse(
      this.chat.contentOf(response),
      input.topics.map((t) => t.id),
    );
    return { assignments, model: response.model ?? config.model, raw: response };
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
