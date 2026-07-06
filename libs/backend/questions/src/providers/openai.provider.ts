import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { extractedQuestionSchema, type ExtractedQuestion } from '@plaudern/contracts';
import type {
  QuestionExtractionInput,
  QuestionExtractionProvider,
  QuestionExtractionResult,
} from '../questions.provider';

/**
 * Extracts open questions via an OpenAI-compatible `/chat/completions`
 * endpoint. The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `questions`) — any provider exposing the
 * OpenAI schema works (DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp
 * server, …), the local-model tier that keeps sensitive transcripts off the
 * network. Only text is sent to the configured endpoint; no audio ever leaves
 * our infra.
 */
@Injectable()
export class OpenAiQuestionExtractionProvider implements QuestionExtractionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async extract(
    userId: string,
    input: QuestionExtractionInput,
  ): Promise<QuestionExtractionResult> {
    const config = await this.aiConfig.resolve(userId, 'questions');
    if (!config) {
      throw new Error(
        'question extraction is not configured — assign a provider to the questions capability in Settings → AI',
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
    const questions = parseQuestionsResponse(this.chat.contentOf(response));
    return { questions, model: response.model ?? config.model, raw: response };
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
