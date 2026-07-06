import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  CitationVerifier,
  VerificationInput,
  VerificationResult,
  VerifiedField,
} from '../verification.provider';

const SYSTEM_PROMPT = [
  'You are a strict fact-checker for a memory-prosthesis app. You are given an',
  'ANSWER generated from a set of numbered SOURCE passages, and the SOURCES.',
  'Your ONLY job is to verify the HIGH-STAKES concrete details in the answer —',
  'dates, times, amounts/quantities/money, and proper names — against the',
  'SOURCES. Do not judge style, completeness, or anything else.',
  '',
  'For each high-stakes value that appears in the answer, decide whether the',
  'SOURCES actually support it AS WRITTEN. A value is NOT supported if the',
  'sources say something different, are silent about it, or only vaguely imply',
  'it. When in doubt, mark it unsupported — a wrong "fact" is worse than a',
  'flagged one.',
  '',
  'Respond with a single JSON object and nothing else:',
  '  {"fields": [{"value": "<verbatim high-stakes value from the answer>",',
  '               "kind": "date" | "amount" | "name" | "other",',
  '               "supported": true | false}, ...]}',
  'If the answer contains no high-stakes values, return {"fields": []}.',
].join('\n');

/**
 * LLM-judge verifier via an OpenAI-compatible `/chat/completions` endpoint.
 * The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `verification`, which inherits from
 * `summarization` at resolve time); any provider exposing the OpenAI schema
 * works. When the capability is not configured callers skip verification.
 */
@Injectable()
export class OpenAiCitationVerifier implements CitationVerifier {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async verify(userId: string, input: VerificationInput): Promise<VerificationResult> {
    const config = await this.aiConfig.resolve(userId, 'verification');
    if (!config) {
      throw new Error(
        'citation verification is not configured — assign a provider to the verification ' +
          'capability in Settings → AI',
      );
    }

    const sources = input.passages
      .map((passage, index) => `[${index + 1}] """${passage}"""`)
      .join('\n');
    const user = `SOURCES:\n${sources}\n\nANSWER:\n${input.answer}`;

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    });
    return {
      fields: parseFields(this.chat.contentOf(response)),
      model: response.model ?? config.model,
      raw: response,
    };
  }
}

/** Parse the judge's JSON reply defensively (mirrors the other providers). */
function parseFields(content: string): VerifiedField[] {
  const parsed = extractJsonObject(content);
  const raw = Array.isArray(parsed.fields) ? parsed.fields : [];
  const fields: VerifiedField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!value) continue;
    const kind = normalizeKind(record.kind);
    // Anything not explicitly true is treated as unsupported (fail closed).
    const supported = record.supported === true;
    fields.push({ value, kind, supported });
  }
  return fields;
}

function normalizeKind(value: unknown): VerifiedField['kind'] {
  return value === 'date' || value === 'amount' || value === 'name' ? value : 'other';
}

function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [unfenced, trimmed]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value as Record<string, unknown>;
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
