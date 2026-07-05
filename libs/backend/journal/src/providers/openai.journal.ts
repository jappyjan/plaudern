import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  JournalProvider,
  JournalProviderInput,
  JournalProviderResult,
} from '../journal.provider';

/**
 * Composes a journal entry via an OpenAI-compatible `/chat/completions`
 * endpoint. The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `journal`, which inherits the
 * summarization assignment when unset). Only derived text
 * (summaries/transcripts, or the daily entries themselves for a rollup) is
 * sent, never audio, and only to the configured LLM endpoint.
 */
@Injectable()
export class OpenAiJournalProvider implements JournalProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async generate(userId: string, input: JournalProviderInput): Promise<JournalProviderResult> {
    const config = await this.aiConfig.resolve(userId, 'journal');
    if (!config) {
      throw new Error(
        'auto-journal is not configured — assign a provider to the journal capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(input.periodType) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    return {
      markdown: parseJournalResponse(this.chat.contentOf(response)),
      model: response.model ?? config.model,
      raw: response,
    };
  }
}

const CITATION_RULES = [
  'Citation rules (CRITICAL — this is a cited entry):',
  '- EVERY concrete claim must cite the source(s) it rests on with inline markers like [1] or [2][3], using ONLY the numbers from the provided sources.',
  '- Never invent a source number that was not provided, and never state anything not supported by a source.',
  '- Place the marker(s) at the end of the sentence the claim appears in.',
  '- Do not add a "Sources" or "References" section — the app renders citation chips itself.',
];

const WRITING_RULES = [
  'Writing rules:',
  '- Write in the dominant language of the sources.',
  '- Write in a warm, first-person reflective diary voice ("I …"), not a bland report.',
  '- Be faithful: never embellish beyond what the sources support.',
  '- Do NOT restate the date/period as a top-level (#) heading; start with the prose.',
];

/** The system prompt for a daily diary entry vs a rollup review. */
export function systemPrompt(periodType: JournalProviderInput['periodType']): string {
  if (periodType === 'day') {
    return [
      'You are the private journalist of a personal life-logging app. You compose a single day into a narrative diary entry FOR the user — a life journal they never had to write themselves.',
      'You are given the numbered signals from one day: recordings (with their summaries/transcripts) and calendar events.',
      'Weave them into a flowing, first-person diary entry that tells the story of the day — what happened, who was involved, how it connected.',
      '',
      'Always respond with a single JSON object and nothing else, with exactly one key:',
      '  "markdown": the diary entry body as GitHub-flavored Markdown.',
      '',
      'Structure with a short flowing narrative first; you MAY add brief thematic subsections (## …) only when the day clearly had distinct threads. A quiet day is a short entry — never pad.',
      '',
      ...CITATION_RULES,
      '',
      ...WRITING_RULES,
    ].join('\n');
  }
  const span =
    periodType === 'week' ? 'week' : periodType === 'month' ? 'month' : 'year';
  return [
    `You are the private journalist of a personal life-logging app. You compose a reflective ${span} review FOR the user (like "Your June"), summarizing the period from its DAILY diary entries.`,
    `You are given the numbered daily entries that make up this ${span}.`,
    `Write a cohesive first-person retrospective that surfaces the arc of the ${span}: recurring themes, notable moments, people, progress and open threads — synthesizing across days rather than listing each one.`,
    '',
    'Always respond with a single JSON object and nothing else, with exactly one key:',
    '  "markdown": the review body as GitHub-flavored Markdown.',
    '',
    'You MAY use short thematic subsections (## …). Keep it tight and readable — highlight, do not transcribe.',
    '',
    ...CITATION_RULES.map((line) =>
      line.startsWith('- EVERY')
        ? '- EVERY concrete claim must cite the daily entries it draws on with inline markers like [1] or [2][3], using ONLY the numbers from the provided sources.'
        : line,
    ),
    '',
    ...WRITING_RULES,
  ].join('\n');
}

/** Build the user message: the period, the current entry, and the numbered sources. */
export function buildUserPrompt(input: JournalProviderInput): string {
  const parts: string[] = [];
  const noun =
    input.periodType === 'day' ? 'day' : `${input.periodType}`;
  parts.push(`Compose the ${noun}: ${input.periodLabel}`);
  parts.push('');

  if (input.previousMarkdown && input.previousMarkdown.trim()) {
    parts.push(
      'Current entry (update it — keep what still holds, revise and extend with the sources below):',
      '"""',
      input.previousMarkdown.trim(),
      '"""',
      '',
    );
  } else {
    parts.push('There is no entry yet — write the first version.', '');
  }

  const label = input.periodType === 'day' ? 'Signals' : 'Daily entries';
  parts.push(`${label} (${input.sources.length}), oldest first — cite them by their [number]:`);
  for (const source of input.sources) {
    const kind =
      source.kind === 'event' ? 'calendar event' : source.kind === 'journal' ? 'day' : 'recording';
    const meta = [`${kind}`, source.title ?? 'Untitled', source.occurredAt]
      .filter(Boolean)
      .join(' · ');
    parts.push('', `[${source.marker}] ${meta}`, source.text.trim());
  }
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping, but
 * require a usable markdown body.
 */
export function parseJournalResponse(content: string): string {
  const json = extractJsonObject(content);
  const markdown = typeof json.markdown === 'string' ? json.markdown.trim() : '';
  if (!markdown) throw new Error('journal response had no markdown body');
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
  throw new Error('journal response was not valid JSON');
}
