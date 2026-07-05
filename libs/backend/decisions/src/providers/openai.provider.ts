import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { extractedDecisionSchema, type ExtractedDecision } from '@plaudern/contracts';
import type {
  DecisionExtractionInput,
  DecisionExtractionProvider,
  DecisionExtractionResult,
} from '../decisions.provider';

/**
 * Extracts decisions via an OpenAI-compatible `/chat/completions` endpoint.
 * The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `decisions`) — any provider exposing the
 * OpenAI schema works (DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp
 * server, …), the local-model tier that keeps sensitive transcripts off the
 * network. Only text is sent to the configured endpoint; no audio ever leaves
 * our infra.
 */
@Injectable()
export class OpenAiDecisionExtractionProvider implements DecisionExtractionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async extract(
    userId: string,
    input: DecisionExtractionInput,
  ): Promise<DecisionExtractionResult> {
    const config = await this.aiConfig.resolve(userId, 'decisions');
    if (!config) {
      throw new Error(
        'decision extraction is not configured — assign a provider to the decisions capability in Settings → AI',
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
    const decisions = parseDecisionsResponse(this.chat.contentOf(response));
    return { decisions, model: response.model ?? config.model, raw: response };
  }
}

export const SYSTEM_PROMPT = [
  'You extract DECISIONS from a transcribed conversation for a note-taking app.',
  'A decision is a choice that was actually MADE or agreed to in the recording —',
  '"we decided to go with the cheaper option", "I\'ll switch banks", "we agreed to',
  'postpone the trip". A decision is a resolution, not a plan under debate.',
  '',
  'The transcript may be speaker-attributed with LABEL: prefixes (e.g. SPEAKER_00:).',
  'Use the speaker roster to name the participants involved in each decision.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "decisions": [ {',
  '      "decision": <the decision in a short phrase>,',
  '      "context": <the reasoning/why behind it, or null>,',
  '      "participants": <who was involved, e.g. "Anna and me", or "" if unknown>,',
  '      "confidence": <your confidence 0..1 that this is a real decision>,',
  '      "sourceQuote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- Only include decisions that were actually resolved — not open questions,',
  '  ideas floated, or options still being weighed. Prefer precision over recall.',
  '- context captures WHY the decision was made (the reasoning), when stated.',
  '- participants names the people who made or agreed to the decision; "" if unclear.',
  '- confidence is a number between 0 and 1; use lower values when unsure.',
  '- If there are no decisions, return { "decisions": [] }.',
].join('\n');

/** Build the user message: metadata + speaker roster + the transcript. */
export function buildUserPrompt(input: DecisionExtractionInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`recorded at: ${input.occurredAt}`);
  if (meta.length > 0) parts.push(`Recording metadata — ${meta.join(', ')}.`, '');

  if (input.speakers.length > 0) {
    parts.push('Speakers:');
    for (const s of input.speakers) {
      parts.push(`- ${s.label}: ${s.displayName}`);
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
export function parseDecisionsResponse(content: string): ExtractedDecision[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { decisions?: unknown }).decisions)
    ? (json as { decisions: unknown[] }).decisions
    : [];
  const decisions: ExtractedDecision[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = extractedDecisionSchema.safeParse(raw);
    if (parsed.success) decisions.push(parsed.data);
  }
  return decisions;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no decisions) rather than throwing when
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
