import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TopicDocumentInput,
  TopicDocumentProvider,
  TopicDocumentResult,
} from '../topic-document.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Generates a topic's living document via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) but any
 * provider exposing the OpenAI schema works by overriding TOPIC_DOCS_BASE_URL/
 * MODEL, including a local Ollama/llama.cpp gateway (TOPIC_DOCS_ENABLED=true for
 * keyless local servers). Only item text (summaries/transcripts) is sent, never
 * audio, and only to the endpoint the operator configures.
 */
@Injectable()
export class OpenAiTopicDocumentProvider implements TopicDocumentProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiTopicDocumentProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    // Falls back to the summarization tier so one DeepSeek key lights up every
    // LLM feature; TOPIC_DOCS_* overrides diverge the model/endpoint per kind.
    this.baseUrl = config
      .get<string>(
        'TOPIC_DOCS_BASE_URL',
        config.get<string>('SUMMARIZATION_BASE_URL', 'https://api.deepseek.com/v1'),
      )
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>(
      'TOPIC_DOCS_API_KEY',
      config.get<string>('SUMMARIZATION_API_KEY', ''),
    );
    this.model = config.get<string>('TOPIC_DOCS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('TOPIC_DOCS_TIMEOUT_MS', String(3 * 60_000)));
    this.explicitlyEnabled = config.get<string>('TOPIC_DOCS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async generate(input: TopicDocumentInput): Promise<TopicDocumentResult> {
    if (!this.enabled) {
      throw new Error(
        'topic documents are disabled — set TOPIC_DOCS_API_KEY (cloud endpoints) or ' +
          'TOPIC_DOCS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`topic document request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      return { markdown: parseDocumentResponse(content), model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
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
