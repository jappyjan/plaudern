import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  TopicProposalLabelInput,
  TopicProposalLabelProvider,
  TopicProposalLabelResult,
} from '../topic-proposals.provider';

/**
 * Labels an embedding cluster with a short topic name (JJ-64) via an
 * OpenAI-compatible `/chat/completions` endpoint. The endpoint/model come from
 * the user's DB-backed AI config (`@plaudern/ai-config`) — labeling is part of
 * the topics capability, so it resolves the `topics` capability, sharing the
 * user's topic-classification provider. Only text excerpts are sent, never audio.
 */
@Injectable()
export class OpenAiTopicProposalLabelProvider implements TopicProposalLabelProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async label(userId: string, input: TopicProposalLabelInput): Promise<TopicProposalLabelResult> {
    const config = await this.aiConfig.resolve(userId, 'topics');
    if (!config) {
      throw new Error(
        'topic labeling is not configured — add an AI provider and assign it to the ' +
          'topics capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LABEL_SYSTEM_PROMPT },
        { role: 'user', content: buildLabelPrompt(input) },
      ],
    });
    const parsed = parseLabelResponse(this.chat.contentOf(response));
    return { ...parsed, model: response.model ?? config.model };
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
