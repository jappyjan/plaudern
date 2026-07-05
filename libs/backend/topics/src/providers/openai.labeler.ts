import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TopicProposalLabelInput,
  TopicProposalLabelProvider,
  TopicProposalLabelResult,
} from '../topic-proposals.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Labels an embedding cluster with a short topic name (JJ-64) via the same
 * OpenAI-compatible `/chat/completions` endpoint and TOPICS_* configuration
 * that topic classification uses (DeepSeek by default). Sharing the key/endpoint
 * keeps configuration to one place; only text excerpts are sent, never audio.
 */
@Injectable()
export class OpenAiTopicProposalLabelProvider implements TopicProposalLabelProvider {
  readonly id: string;
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
    this.explicitlyEnabled = config.get<string>('TOPICS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async label(input: TopicProposalLabelInput): Promise<TopicProposalLabelResult> {
    if (!this.enabled) {
      throw new Error(
        'topic labeling is disabled — set TOPICS_API_KEY (cloud endpoints) or ' +
          'TOPICS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
            { role: 'system', content: LABEL_SYSTEM_PROMPT },
            { role: 'user', content: buildLabelPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`topic labeling request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const parsed = parseLabelResponse(content);
      return { ...parsed, model: json.model ?? this.model };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const LABEL_SYSTEM_PROMPT = [
  'You name a cluster of related notes for a note-taking app, proposing a topic/project the user could create.',
  'Always respond with a single JSON object and nothing else, with the keys:',
  '  "label": a short noun phrase naming the shared topic/project (2-4 words, Title Case),',
  '  "description": one short sentence describing what the topic covers.',
  '',
  'Rules:',
  '- Base the name only on what the notes share; be specific, not generic ("Kitchen Renovation", not "Home").',
  '- Write the label and description in the same language as the notes.',
  '- Do not add commentary; return only the JSON object.',
].join('\n');

/** Build the user message: the sample note excerpts to summarize into a label. */
export function buildLabelPrompt(input: TopicProposalLabelInput): string {
  const parts: string[] = [];
  if (input.language) parts.push(`Notes language: ${input.language}.`, '');
  parts.push('Sample notes from the cluster:');
  input.samples.forEach((sample, i) => {
    parts.push('', `Note ${i + 1}:`, '"""', sample.trim(), '"""');
  });
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping, coerce
 * missing fields, and normalize whitespace. Returns an empty label when nothing
 * usable is present, so the caller can skip rather than throw.
 */
export function parseLabelResponse(content: string): { label: string; description: string | null } {
  const json = extractJsonObject(content);
  const label = typeof json.label === 'string' ? json.label.trim() : '';
  const description =
    typeof json.description === 'string' && json.description.trim().length > 0
      ? json.description.trim()
      : null;
  return { label, description };
}

function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [unfenced, trimmed]) {
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
