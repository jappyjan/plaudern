import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import { extractedReminderSchema, type ExtractedReminder } from '@plaudern/contracts';
import type {
  ReminderExtractionInput,
  ReminderExtractionProvider,
  ReminderExtractionResult,
} from '../reminders.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts prospective-memory reminders via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) — the
 * cheapest capable option — but any provider exposing the OpenAI schema works
 * by overriding REMINDERS_BASE_URL/MODEL, including a **local Ollama** server
 * (`REMINDERS_BASE_URL=http://localhost:11434/v1`) — the local-model tier that
 * keeps sensitive transcripts off the network, mirroring the decisions/questions
 * extractors.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiReminderExtractionProvider implements ReminderExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiReminderExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(
    config: ConfigService,
    private readonly audit: AiAuditRecorder,
  ) {
    this.baseUrl = config
      .get<string>('REMINDERS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('REMINDERS_API_KEY', '');
    this.model = config.get<string>('REMINDERS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('REMINDERS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) opt in
    // explicitly via REMINDERS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('REMINDERS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: ReminderExtractionInput): Promise<ReminderExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'reminder extraction is disabled — set REMINDERS_API_KEY (cloud endpoints) or ' +
          'REMINDERS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Most local servers (Ollama, llama.cpp) ignore auth entirely; only send
      // the header when a key was actually configured.
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const endpoint = `${this.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
      });
      // Audit the exact bytes leaving the box before they leave (JJ-42).
      await this.audit.record({ provider: this.id, endpoint, payload: body });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `reminder extraction request failed: ${res.status} ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const reminders = parseRemindersResponse(content);
      return { reminders, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract PROSPECTIVE-MEMORY EVENTS from a transcribed note or conversation',
  'for a note-taking app: anything anchored to a FUTURE date that the user would',
  'want reminded of — "the results should be in by the 14th", "let\'s talk again',
  'next month", a contract expiry, a deadline, an appointment, a follow-up.',
  '',
  'You are given the recording date. Resolve every relative date reference',
  '("next month", "the 14th", "in two weeks", "on Friday") AGAINST THE RECORDING',
  'DATE — never against today — and return it as an absolute YYYY-MM-DD date when',
  'you can. If a reference is genuinely ambiguous, return the raw phrase verbatim',
  'in dueDate and the app will resolve it against the recording date.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "reminders": [ {',
  '      "title": <short phrase for what to be reminded of>,',
  '      "dueDate": <absolute YYYY-MM-DD, or the raw date phrase>,',
  '      "confidence": <your confidence 0..1 that this is a real future reminder>,',
  '      "sourceQuote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- Only include items with a FUTURE date relative to the recording. Ignore',
  '  purely past events and things with no date at all.',
  '- Prefer precision over recall; use lower confidence when unsure.',
  '- Keep the title concise and self-contained.',
  '- If there are no future-dated events, return { "reminders": [] }.',
].join('\n');

/** Build the user message: metadata + the transcript. */
export function buildUserPrompt(input: ReminderExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.occurredAt) meta.push(`recording date: ${input.occurredAt}`);
  if (input.language) meta.push(`language: ${input.language}`);
  if (meta.length > 0) parts.push(`Recording metadata — ${meta.join(', ')}.`, '');

  parts.push('Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, validate each entry through the contract schema, drop
 * malformed entries rather than throwing, and always return a (possibly empty)
 * array.
 */
export function parseRemindersResponse(content: string): ExtractedReminder[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { reminders?: unknown }).reminders)
    ? (json as { reminders: unknown[] }).reminders
    : [];
  const reminders: ExtractedReminder[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = extractedReminderSchema.safeParse(raw);
    if (parsed.success) reminders.push(parsed.data);
  }
  return reminders;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no reminders) rather than throwing when
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
