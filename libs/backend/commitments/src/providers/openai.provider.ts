import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractedCommitmentSchema, type ExtractedCommitment } from '@plaudern/contracts';
import type {
  CommitmentExtractionInput,
  CommitmentExtractionProvider,
  CommitmentExtractionResult,
} from '../commitments.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts promissory commitments via an OpenAI-compatible `/chat/completions`
 * endpoint. Defaults to DeepSeek (`deepseek-chat`) — the cheapest capable
 * option — but any provider exposing the OpenAI schema works by overriding
 * COMMITMENTS_BASE_URL/MODEL, including a **local Ollama** server
 * (`COMMITMENTS_BASE_URL=http://localhost:11434/v1`) — the local-model tier
 * that keeps sensitive transcripts off the network, mirroring the entities and
 * topics extractors.
 *
 * Only text is sent to the configured endpoint; no audio ever leaves our infra.
 */
@Injectable()
export class OpenAiCommitmentExtractionProvider implements CommitmentExtractionProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiCommitmentExtractionProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('COMMITMENTS_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('COMMITMENTS_API_KEY', '');
    this.model = config.get<string>('COMMITMENTS_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('COMMITMENTS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, …) opt in
    // explicitly via COMMITMENTS_ENABLED=true.
    this.explicitlyEnabled = config.get<string>('COMMITMENTS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: CommitmentExtractionInput): Promise<CommitmentExtractionResult> {
    if (!this.enabled) {
      throw new Error(
        'commitment extraction is disabled — set COMMITMENTS_API_KEY (cloud endpoints) or ' +
          'COMMITMENTS_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
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
          `commitment extraction request failed: ${res.status} ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const commitments = parseCommitmentsResponse(content);
      return { commitments, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You extract promissory COMMITMENTS from a transcribed conversation for a note-taking app.',
  'A commitment is a promise/obligation to do something — in either direction:',
  '  - owed_by_me: the note owner ("me"/"I") promised to do something.',
  '  - owed_to_me: someone else promised to do something for the owner.',
  '',
  'The transcript may be speaker-attributed with LABEL: prefixes (e.g. SPEAKER_00:).',
  'The speaker roster in the user message marks exactly one participant as the',
  'owner ("me"). Attribute direction relative to THAT owner: things the owner',
  'promises ("I\'ll send you the draft") are owed_by_me; things any other',
  'participant promises — including reported speech like "Tom said he\'d check',
  'with the landlord" — are owed_to_me.',
  'If the roster gives the owner\'s name but the transcript has no speaker labels,',
  'use the name to decide direction. Only when neither the owner label nor name',
  'can be found in the transcript should you fall back to first-person language.',
  '',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "commitments": [ {',
  '      "direction": "owed_by_me" | "owed_to_me",',
  '      "counterparty": <the OTHER party\'s name, or "" if unknown>,',
  '      "description": <short phrase naming the obligation>,',
  '      "duePhrase": <the exact time expression stated ("by Friday", "next week"), or null>,',
  '      "sourceQuote": <the short transcript span it came from, or null>',
  '  }, ... ] }',
  '',
  'Rules:',
  '- counterparty is the person on the OTHER side: for owed_by_me it is who I owe;',
  '  for owed_to_me it is who owes me. Use their name if stated, else "".',
  '- Only include genuine promises/obligations; ignore hypotheticals, questions and',
  '  idle chatter. Prefer precision over recall.',
  '- Do NOT resolve the due date yourself; return the raw phrase in duePhrase.',
  '- If there are no commitments, return { "commitments": [] }.',
].join('\n');

/** Build the user message: metadata + speaker roster + the transcript. */
export function buildUserPrompt(input: CommitmentExtractionInput): string {
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

  // The owner's name anchors direction even when they were not diarized as a
  // labelled speaker (e.g. a single-speaker note or an untagged transcript).
  if (input.ownerName) {
    parts.push(`The owner ("me") is ${input.ownerName}.`, '');
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
export function parseCommitmentsResponse(content: string): ExtractedCommitment[] {
  const json = extractJsonObject(content);
  const rawList = Array.isArray((json as { commitments?: unknown }).commitments)
    ? (json as { commitments: unknown[] }).commitments
    : [];
  const commitments: ExtractedCommitment[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = extractedCommitmentSchema.safeParse(raw);
    if (parsed.success) commitments.push(parsed.data);
  }
  return commitments;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ no commitments) rather than throwing when
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
