import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { summaryLayoutSchema, type SummaryLayout } from '@plaudern/contracts';
import type {
  SummarizationInput,
  SummarizationProvider,
  SummarizationResult,
} from '../summarization.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/** Human-facing description of every layout, injected into the prompt. */
const LAYOUT_GUIDE: Record<SummaryLayout, string> = {
  meeting:
    'a meeting/standup with multiple participants: use sections for Attendees, Key points, Decisions, and a `- [ ]` checklist of Action items (attribute each to a speaker). A mermaid diagram is welcome when it clarifies a flow or timeline.',
  interview:
    'an interview or Q&A: summarize the main questions and answers, optionally as `#### Question` / answer pairs.',
  lecture:
    'a lecture, talk or tutorial: an outline of topics with key concepts; a mermaid `mindmap` or `flowchart` is often useful.',
  conversation:
    'a casual multi-person conversation: a short narrative plus the notable points raised by each speaker.',
  note: 'a personal voice memo or single-speaker note: a tight TL;DR followed by a few bullet points.',
  todo: 'primarily tasks/reminders: a `- [ ]` checklist of the todos, grouped if helpful.',
  general: 'anything that does not fit the others: a concise summary with sensible headings.',
};

/**
 * Summarizes via an OpenAI-compatible `/chat/completions` endpoint. Defaults to
 * DeepSeek (`deepseek-chat`) — the cheapest capable option — but any provider
 * exposing the OpenAI schema works by overriding SUMMARIZATION_BASE_URL/MODEL.
 *
 * The transcript never leaves our infra except to the configured LLM endpoint,
 * which the operator chooses; no audio is sent, only text.
 */
@Injectable()
export class OpenAiSummarizationProvider implements SummarizationProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiSummarizationProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('SUMMARIZATION_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('SUMMARIZATION_API_KEY', '');
    this.model = config.get<string>('SUMMARIZATION_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('SUMMARIZATION_TIMEOUT_MS', String(2 * 60_000)));
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  async summarize(input: SummarizationInput): Promise<SummarizationResult> {
    if (!this.enabled) {
      throw new Error(
        'SUMMARIZATION_API_KEY is not set — cannot summarize with the OpenAI-compatible provider',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.3,
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
        throw new Error(`summarization request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const parsed = parseSummaryResponse(content);
      return { ...parsed, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

const SYSTEM_PROMPT = [
  'You summarize a transcribed audio recording for a note-taking app.',
  'Always respond with a single JSON object and nothing else, with keys:',
  '  "title": a short, specific, descriptive title (max ~8 words, no trailing punctuation),',
  '  "layout": one of the layout ids listed by the user,',
  '  "markdown": the summary body as GitHub-flavored Markdown.',
  '',
  'Markdown rules:',
  '- Write in the output language stated in the user message.',
  '- Do NOT repeat the title as a top-level heading inside the markdown.',
  '- You may use mermaid diagrams inside ```mermaid fenced code blocks when they add clarity (flowchart, sequenceDiagram, mindmap, timeline). Keep them syntactically valid and simple.',
  '- When you refer to a speaker in prose, mention them with the exact token @[LABEL] using their diarization LABEL (e.g. @[SPEAKER_00]); the app turns these into clickable chips. Never invent a LABEL that is not in the roster. Inside mermaid diagrams use the plain display name instead of the token.',
  '- If no speaker roster is provided, just write naturally without mention tokens.',
  '- Be faithful to the transcript; do not invent facts. Prefer concise bullet points over long paragraphs.',
].join('\n');

/** Build the user message: roster + metadata + the transcript, plus layout menu. */
export function buildUserPrompt(input: SummarizationInput): string {
  const parts: string[] = [];

  parts.push(
    input.targetLanguage
      ? `Write the title and the entire summary in ${input.targetLanguage}, regardless of the transcript's language.`
      : "Write the title and the entire summary in the transcript's own language.",
    '',
  );

  parts.push('Choose the single best layout for this recording:');
  for (const layout of summaryLayoutSchema.options) {
    parts.push(`- ${layout}: ${LAYOUT_GUIDE[layout]}`);
  }

  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (typeof input.durationSeconds === 'number') {
    meta.push(`duration: ${Math.round(input.durationSeconds)}s`);
  }
  if (meta.length > 0) {
    parts.push('', `Recording metadata — ${meta.join(', ')}.`);
  }

  if (input.speakers.length > 0) {
    parts.push(
      '',
      'Speaker roster (use @[LABEL] to mention a speaker in prose):',
      ...input.speakers.map(
        (s) => `- ${s.label} = ${s.displayName}${s.confirmed ? '' : ' (unconfirmed)'}`,
      ),
    );
  }

  parts.push('', 'Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and an
 * unknown layout (falls back to `general`), but require a usable markdown body.
 */
export function parseSummaryResponse(content: string): {
  title: string;
  layout: SummaryLayout;
  markdown: string;
} {
  const json = extractJsonObject(content);
  const rawTitle = typeof json.title === 'string' ? json.title.trim() : '';
  const rawMarkdown = typeof json.markdown === 'string' ? json.markdown.trim() : '';
  if (!rawMarkdown) {
    throw new Error('summarization response had no markdown body');
  }
  const layoutParse = summaryLayoutSchema.safeParse(json.layout);
  return {
    title: rawTitle || 'Untitled recording',
    layout: layoutParse.success ? layoutParse.data : 'general',
    markdown: rawMarkdown,
  };
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
  throw new Error('summarization response was not valid JSON');
}
