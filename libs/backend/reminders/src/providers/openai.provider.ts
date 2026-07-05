import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { extractedReminderSchema, type ExtractedReminder } from '@plaudern/contracts';
import type {
  ReminderExtractionInput,
  ReminderExtractionProvider,
  ReminderExtractionResult,
} from '../reminders.provider';

/**
 * Extracts prospective-memory reminders via an OpenAI-compatible
 * `/chat/completions` endpoint. The endpoint/model come from the user's
 * DB-backed AI config (`@plaudern/ai-config`, capability `reminders`) — any
 * provider exposing the OpenAI schema works (DeepSeek, OpenAI, OpenRouter, a
 * local Ollama/llama.cpp server, …), the local-model tier keeping sensitive
 * transcripts off the network.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiReminderExtractionProvider implements ReminderExtractionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async extract(
    userId: string,
    input: ReminderExtractionInput,
  ): Promise<ReminderExtractionResult> {
    const config = await this.aiConfig.resolve(userId, 'reminders');
    if (!config) {
      throw new Error(
        'reminder extraction is not configured — assign a provider to the reminders ' +
          'capability in Settings → AI',
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
    const reminders = parseRemindersResponse(this.chat.contentOf(response));
    return { reminders, model: response.model ?? config.model, raw: response };
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
