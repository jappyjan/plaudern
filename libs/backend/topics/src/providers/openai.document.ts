import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  TopicDocumentInput,
  TopicDocumentProvider,
  TopicDocumentResult,
} from '../topic-document.provider';

/**
 * Generates a topic's living document via an OpenAI-compatible
 * `/chat/completions` endpoint. The endpoint/model come from the user's
 * DB-backed AI config (`@plaudern/ai-config`, capability `topic_docs`, which
 * inherits from summarization when unset) — any provider exposing the OpenAI
 * schema works. Only item text (summaries/transcripts) is sent, never audio.
 */
@Injectable()
export class OpenAiTopicDocumentProvider implements TopicDocumentProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async generate(userId: string, input: TopicDocumentInput): Promise<TopicDocumentResult> {
    const config = await this.aiConfig.resolve(userId, 'topic_docs');
    if (!config) {
      throw new Error(
        'topic documents are not configured — add an AI provider and assign it to the ' +
          'topic_docs capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return {
      markdown: parseDocumentResponse(this.chat.contentOf(response)),
      model: response.model ?? config.model,
      raw: response,
    };
  }
}

export const SYSTEM_PROMPT = [
  'You maintain an evergreen "living document" for a topic/project in a personal note-taking app.',
  'You are given numbered source items (summaries or transcript excerpts) that were classified into this topic, and the current document (if any).',
  'Rewrite the document so it reflects EVERYTHING known from the sources — updating the previous version rather than discarding it.',
  '',
  'Always respond with a single JSON object and nothing else, with exactly one key:',
  '  "markdown": the living document body as GitHub-flavored Markdown.',
  '',
  'Structure the markdown with these sections when there is content for them (omit empty ones):',
  '  ## Overview — the current state of the topic in a few sentences.',
  '  ## Timeline — dated bullet points of what happened, oldest first.',
  '  ## Decisions — decisions made and their rationale.',
  '  ## Open items — unresolved questions, todos and next steps.',
  '  ## People — people involved and their role.',
  '',
  'Citation rules (CRITICAL — this is a cited document):',
  '- EVERY factual statement must cite the source item(s) it rests on with inline markers like [1] or [2][3], using ONLY the numbers from the provided sources.',
  '- Never invent a source number that was not provided, and never state anything not supported by a source.',
  '- Place the marker(s) at the end of the sentence or bullet the claim appears in.',
  '- Do not add a "Sources" or "References" section — the app renders citation chips itself.',
  '',
  'Writing rules:',
  "- Write in the dominant language of the sources.",
  '- Do NOT repeat the topic name as a top-level (#) heading; start with the ## sections.',
  '- Be faithful and concise; prefer bullet points over long paragraphs. Do not pad.',
].join('\n');

/** Build the user message: topic, the current document, and the numbered sources. */
export function buildUserPrompt(input: TopicDocumentInput): string {
  const parts: string[] = [];
  parts.push(`Topic: ${input.topicName}`);
  if (input.topicDescription) parts.push(`Topic description: ${input.topicDescription}`);
  parts.push('');

  if (input.previousMarkdown && input.previousMarkdown.trim()) {
    parts.push(
      'Current document (update it — keep what still holds, revise what changed, add what is new):',
      '"""',
      input.previousMarkdown.trim(),
      '"""',
      '',
    );
  } else {
    parts.push('There is no document yet — write the first version.', '');
  }

  parts.push(`Source items (${input.sources.length}), oldest first — cite them by their [number]:`);
  for (const source of input.sources) {
    const meta = [source.title ?? 'Untitled', source.occurredAt].filter(Boolean).join(' · ');
    parts.push('', `[${source.marker}] ${meta}`, source.text.trim());
  }
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping, but
 * require a usable markdown body.
 */
export function parseDocumentResponse(content: string): string {
  const json = extractJsonObject(content);
  const markdown = typeof json.markdown === 'string' ? json.markdown.trim() : '';
  if (!markdown) throw new Error('topic document response had no markdown body');
  return markdown;
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
  throw new Error('topic document response was not valid JSON');
}
