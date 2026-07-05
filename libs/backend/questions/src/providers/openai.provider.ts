import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractedQuestionSchema, type ExtractedQuestion } from '@plaudern/contracts';
import type {
  QuestionExtractionInput,
  QuestionExtractionProvider,
  QuestionExtractionResult,
} from '../questions.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts open questions via an OpenAI-compatible `/chat/completions`
 * endpoint. Defaults to DeepSeek (`deepseek-chat`) — the cheapest capable
 * option — but any provider exposing the OpenAI schema works by overriding
 * QUESTIONS_BASE_URL/MODEL, including a **local Ollama** server
 * (`QUESTIONS_BASE_URL=http://localhost:11434/v1`) — the local-model tier that
 * keeps sensitive transcripts off the network, mirroring the commitments and
 * topics extractors.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiQuestionExtractionProvider implements QuestionExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiQuestionExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('QUESTIONS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('QUESTIONS_API_KEY', '');
    this.model = config.get<string>('QUESTIONS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('QUESTIONS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) opt in
    // explicitly via QUESTIONS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('QUESTIONS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: QuestionExtractionInput): Promise<QuestionExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'question extraction is disabled — set QUESTIONS_API_KEY (cloud endpoints) or ' +
          'QUESTIONS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `question extraction request failed: ${res.status} ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const questions = parseQuestionsResponse(content);
      return { questions, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract OPEN QUESTIONS from a transcribed conversation for a note-taking app.',
  'An open question is a genuine question raised in the recording — in either direction:',
  '  - asked_by_me: the note owner ("me"/"I") asked something.',
  '  - asked_of_me: someone else asked the owner something.',
  '',
  'The transcript may be speaker-attributed with LABEL: prefixes (e.g. SPEAKER_00:).',
  'The owner is the first-person speaker — a question they raise is asked_by_me;',
  'a question directed AT the owner by a NAMED other person is asked_of_me.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "questions": [ {',
  '      "direction": "asked_by_me" | "asked_of_me",',
  '      "counterparty": <the OTHER party\'s name, or "" if unknown>,',
  '      "question": <the question in a short phrase>,',
  '      "answered": <true if the answer appears LATER in this same recording, else false>,',
  '      "sourceQuote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- counterparty is the person on the OTHER side: for asked_by_me who I asked;',
  '  for asked_of_me who asked me. Use their name if stated, else "".',
  '- Only include real, substantive questions — the loops worth remembering.',
  '  Ignore rhetorical questions, filler ("you know?"), and idle chatter.',
  '- Set "answered" true ONLY if the answer is clearly given later in this recording;',
  '  otherwise false. Prefer precision over recall.',
  '- If there are no questions, return { "questions": [] }.',
].join('\n');

/** Build the user message: metadata + speaker roster + the transcript. */
export function buildUserPrompt(input: QuestionExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) parts.push(`Recording metadata — ${meta.join(', ')}.`, '');

  if (input.speakers.length > 0) {
    parts.push('Speakers:');
    for (const s of input.speakers) {
      const owner = input.ownerLabel && s.label === input.ownerLabel ? ' (the owner / me)' : '';
      parts.push(`- ${s.label}: ${s.displayName}${owner}`);
    }
    parts.push('');
  }

  parts.push('Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, validate each entry through the contract schema, drop
 * malformed entries rather than throwing, and always return a (possibly empty)
 * array.
 */
export function parseQuestionsResponse(content: string): ExtractedQuestion[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { questions?: unknown }).questions)
    ? (json as { questions: unknown[] }).questions
    : [];
  const questions: ExtractedQuestion[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = extractedQuestionSchema.safeParse(raw);
    if (parsed.success) questions.push(parsed.data);
  }
  return questions;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no questions) rather than throwing when
 * nothing parses, so a chatty model can't fail the whole job.
 */
export function extractJsonObject(content: string): Record<string, unknown> {
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
