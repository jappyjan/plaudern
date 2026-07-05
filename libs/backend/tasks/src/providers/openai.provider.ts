import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractedTaskSchema, type ExtractedTask } from '@plaudern/contracts';
import type {
  TaskExtractionInput,
  TaskExtractionProvider,
  TaskExtractionResult,
} from '../tasks.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts the user's self-directed tasks via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) — the
 * cheapest capable option — but any provider exposing the OpenAI schema works by
 * overriding TASKS_BASE_URL/MODEL, including a **local Ollama** server
 * (`TASKS_BASE_URL=http://localhost:11434/v1`, `TASKS_MODEL=llama3.1`,
 * `TASKS_ENABLED=true`) — the local-model tier that keeps sensitive transcripts
 * off the network, mirroring summarization/entities/topics.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiTaskExtractionProvider implements TaskExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiTaskExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('TASKS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('TASKS_API_KEY', '');
    this.model = config.get<string>('TASKS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('TASKS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) have no key
    // to set, so they opt in explicitly via TASKS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('TASKS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: TaskExtractionInput): Promise<TaskExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'task extraction is disabled — set TASKS_API_KEY (cloud endpoints) or ' +
          'TASKS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
        throw new Error(`task extraction request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const tasks = parseTasksResponse(content);
      return { tasks, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  "You extract the OWNER'S OWN self-directed tasks (things the owner intends to do)",
  'from a transcribed audio recording or note for a note-taking app.',
  'The user message identifies who the owner ("me") is — by name and, when the',
  'recording is speaker-attributed, by their diarization LABEL.',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "tasks": [ { "title": <string>, "dueDate": <YYYY-MM-DD|null>, "quote": <string> }, ... ] }',
  '',
  'Rules:',
  '- Extract ONLY genuine intentions/action items that belong to the OWNER',
  '  ("I need to book the dentist", "remember to email Anna", "I should renew my passport",',
  '  or a task explicitly assigned TO the owner by name).',
  '- Do NOT extract tasks assigned to any OTHER person, hypotheticals, past/completed',
  '  actions, or general facts and observations. In a multi-speaker transcript, only the',
  "  owner's own statements (or tasks handed to the owner) count.",
  '- If the owner is not named or labelled, treat first-person intentions ("I need to…")',
  '  as the owner\'s.',
  '- "title" is a short imperative rephrasing, e.g. "Book the dentist", "Email Anna".',
  '- "dueDate" is an ISO date (YYYY-MM-DD) if the recording clearly implies one (resolve',
  '  relative references like "tomorrow" against the recording time); otherwise null.',
  '- "quote" is the exact sentence from the text the task was inferred from.',
  '- Deduplicate within this recording: one object per distinct intention.',
  '- Prefer precision over recall. If there are no tasks, return { "tasks": [] }.',
].join('\n');

/** Build the user message: owner + roster + metadata + the text to extract from. */
export function buildUserPrompt(input: TaskExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) {
    parts.push(`Recording metadata — ${meta.join(', ')}.`, '');
  }

  // Identify the owner ("me") so the model scopes tasks to them and excludes
  // everyone else. Both name and label are given when available.
  const ownerBits: string[] = [];
  if (input.ownerName) ownerBits.push(input.ownerName);
  if (input.ownerLabel) ownerBits.push(`label ${input.ownerLabel}`);
  parts.push(
    ownerBits.length > 0
      ? `The owner ("me") is ${ownerBits.join(', ')}. Extract only the owner's tasks.`
      : "The owner (\"me\") is the first-person speaker. Extract only the owner's tasks.",
    '',
  );

  if (input.speakers && input.speakers.length > 0) {
    parts.push('Speakers:');
    for (const s of input.speakers) {
      const owner = input.ownerLabel && s.label === input.ownerLabel ? ' (the owner / me)' : '';
      parts.push(`- ${s.label}: ${s.displayName}${owner}`);
    }
    parts.push('');
  }

  parts.push('Text:', '"""', input.text.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, drop malformed entries rather than throwing, and always
 * return a (possibly empty) array.
 */
/** Bounds on untrusted LLM output — matched to the extractedTaskSchema limits. */
export const MAX_PARSED_TASKS = 50;
const MAX_TITLE_CHARS = 300;
const MAX_QUOTE_CHARS = 1000;

export function parseTasksResponse(content: string): ExtractedTask[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { tasks?: unknown }).tasks)
    ? (json as { tasks: unknown[] }).tasks
    : [];
  const tasks: ExtractedTask[] = [];
  for (const raw of rawList) {
    // Cap the list: a runaway model must not flood the pipeline (the registry
    // enforces the same bound defensively for non-default providers).
    if (tasks.length >= MAX_PARSED_TASKS) break;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    // Coerce loose shapes (nullable strings) and truncate overlong fields
    // before validating, so a verbose model yields a bounded task rather than
    // a dropped one.
    const parsed = extractedTaskSchema.safeParse({
      title:
        typeof candidate.title === 'string'
          ? candidate.title.trim().slice(0, MAX_TITLE_CHARS)
          : candidate.title,
      dueDate: normalizeDate(candidate.dueDate),
      quote:
        typeof candidate.quote === 'string'
          ? candidate.quote.trim().slice(0, MAX_QUOTE_CHARS)
          : null,
    });
    if (parsed.success && parsed.data.title.length > 0) tasks.push(parsed.data);
  }
  return tasks;
}

/** Keep only plausible ISO date strings (bounded); everything else becomes null. */
function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 40) : null;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose.
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
  throw new Error('task extraction response was not valid JSON');
}
