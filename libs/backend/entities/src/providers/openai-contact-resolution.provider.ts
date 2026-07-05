import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  ContactResolutionDecision,
  ContactResolutionInput,
  ContactResolutionProvider,
  ContactResolutionResult,
} from '../contact-resolution.provider';
import { extractJsonObject } from './openai.provider';

/**
 * Decides entity↔contact identity via an OpenAI-compatible `/chat/completions`
 * endpoint. The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `contact_resolution`, which inherits from
 * `entity_extraction` when unset) — wherever entity extraction already runs,
 * resolution works with zero extra setup.
 *
 * Only names and evidence summaries are sent — never transcripts or audio.
 */
@Injectable()
export class OpenAiContactResolutionProvider implements ContactResolutionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async resolve(
    userId: string,
    input: ContactResolutionInput,
  ): Promise<ContactResolutionResult> {
    const config = await this.aiConfig.resolve(userId, 'contact_resolution');
    if (!config) {
      throw new Error(
        'contact resolution is not configured — assign a provider to the ' +
          'contact_resolution capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: RESOLUTION_SYSTEM_PROMPT },
        { role: 'user', content: buildResolutionPrompt(input) },
      ],
    });
    const decision = parseResolutionResponse(
      this.chat.contentOf(response),
      input.candidates.map((c) => c.voiceProfileId),
    );
    return { decision, model: response.model ?? config.model, raw: response };
  }
}

export const RESOLUTION_SYSTEM_PROMPT = [
  'You perform identity resolution for a personal note-taking app: decide whether a person',
  'mentioned in the user\'s voice recordings is the same real person as one of the contacts',
  'from their contact book.',
  'Always respond with a single JSON object and nothing else, of the shape:',
  '  { "voiceProfileId": <candidate id or null>, "confidence": <0..1>, "reason": <short string> }',
  '',
  'Guidance:',
  '- Names may differ by nickname, diminutive, spelling, transliteration or partial form',
  '  ("Detti"/"Detlef", "Mueller"/"Müller", first name only). Use cultural knowledge of names.',
  '- Evidence that the contact speaks in recordings where the person is mentioned, or that both',
  '  share connections in the knowledge graph (same employer, same relatives), supports a match.',
  '- Evidence that the person and the contact are mentioned together in the same recording',
  '  suggests they are DIFFERENT people.',
  '- Only pick a candidate listed in the input. If no candidate is clearly the same person,',
  '  return voiceProfileId null. Prefer null over guessing; a wrong link is worse than none.',
].join('\n');

/** Serialize the evidence dossier for the model. */
export function buildResolutionPrompt(input: ContactResolutionInput): string {
  const lines: string[] = [];
  lines.push('Person mentioned in recordings:');
  lines.push(`- name: ${input.entity.name}`);
  if (input.entity.aliases.length > 0) {
    lines.push(`- also referred to as: ${input.entity.aliases.join(', ')}`);
  }
  if (input.entity.mentionExamples.length > 0) {
    lines.push(`- example mentions: ${input.entity.mentionExamples.join('; ')}`);
  }
  lines.push('', 'Contact-book candidates:');
  for (const candidate of input.candidates) {
    lines.push(`- id: ${candidate.voiceProfileId}`);
    lines.push(`  name: ${candidate.name ?? '(unnamed voice)'}`);
    lines.push(`  heuristic confidence: ${candidate.heuristicConfidence.toFixed(2)}`);
    for (const evidence of candidate.evidence) lines.push(`  evidence: ${evidence}`);
  }
  lines.push('', 'Which candidate, if any, is the same person? Respond with the JSON object only.');
  return lines.join('\n');
}

/**
 * Parse the model's verdict defensively: tolerate fences/prose, clamp the
 * confidence, and treat any id not among the offered candidates as null — the
 * model must not invent contacts.
 */
export function parseResolutionResponse(
  content: string,
  allowedIds: string[],
): ContactResolutionDecision {
  const json = extractJsonObject(content, 'contact resolution');
  const rawId = (json as { voiceProfileId?: unknown }).voiceProfileId;
  const id = typeof rawId === 'string' && allowedIds.includes(rawId) ? rawId : null;
  const rawConfidence = (json as { confidence?: unknown }).confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0;
  const rawReason = (json as { reason?: unknown }).reason;
  const reason = typeof rawReason === 'string' ? rawReason.slice(0, 500) : '';
  return { voiceProfileId: id, confidence, reason };
}
