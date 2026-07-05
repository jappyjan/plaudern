import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { extractedDocMetaSchema, type ExtractedDocMeta } from '@plaudern/contracts';
import type {
  DocMetaInput,
  DocMetaProvider,
  DocMetaResult,
} from '../docmeta.provider';

/**
 * Extracts structured document metadata from OCR text via an OpenAI-compatible
 * `/chat/completions` endpoint. The endpoint/model come from the user's
 * DB-backed AI config (`@plaudern/ai-config`, capability `docmeta`) — it reads
 * the OCR TEXT, not the image, so any provider exposing the OpenAI schema works
 * (DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp server, …).
 */
@Injectable()
export class OpenAiDocMetaProvider implements DocMetaProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async extract(userId: string, input: DocMetaInput): Promise<DocMetaResult> {
    const config = await this.aiConfig.resolve(userId, 'docmeta');
    if (!config) {
      throw new Error(
        'document-metadata extraction is not configured — assign a provider to the docmeta ' +
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
    const docMeta = parseDocMetaResponse(this.chat.contentOf(response));
    return { docMeta, model: response.model ?? config.model, raw: response };
  }
}

export const SYSTEM_PROMPT = [
  'You classify a SCANNED DOCUMENT from its OCR text and extract its key fields',
  'for a personal document vault. The document may be in German or English.',
  '',
  'You are given the scan date. Resolve any relative date reference against the',
  'SCAN DATE and return absolute YYYY-MM-DD dates when you can; otherwise return',
  'the raw phrase and the app will resolve it.',
  '',
  'Respond with a single JSON object and nothing else, of the shape:',
  '  {',
  '    "documentType": one of invoice|receipt|contract|insurance|warranty|letter|',
  '        prescription|id_document|bank_statement|payslip|business_card|other,',
  '    "title": short human title for the document,',
  '    "summary": one-line summary or null,',
  '    "issuer": who the document is from (company/authority/sender) or null,',
  '    "fields": [ { "label": short field name, "value": field value }, ... ],',
  '    "amount": the primary monetary amount as a number or null,',
  '    "currency": ISO-4217 code (e.g. "EUR") or null,',
  '    "iban": an IBAN found on the document or null,',
  '    "expiryDate": when the document/entitlement expires (YYYY-MM-DD or phrase) or null,',
  '    "cancellationDate": the LAST DAY TO CANCEL / Kündigungsfrist deadline or null,',
  '    "contact": for a business_card only: { "fullName", "organization", "jobTitle",',
  '        "email", "phone", "address", "website" } (null fields allowed), else null,',
  '    "confidence": your overall confidence 0..1',
  '  }',
  '',
  'Rules:',
  '- Pay special attention to Kündigungsfrist / cancellation windows and expiry',
  '  dates on contracts, insurance and warranties — those become reminders.',
  '- For a business card, fill "contact" and set documentType to business_card.',
  '- Keep fields concise. If a value is unknown, use null / omit it.',
].join('\n');

/** Build the user message: metadata + the OCR text. */
export function buildUserPrompt(input: DocMetaInput): string {
  const parts: string[] = [];
  const meta: string[] = [];
  if (input.occurredAt) meta.push(`scan date: ${input.occurredAt}`);
  if (input.language) meta.push(`language: ${input.language}`);
  if (meta.length > 0) parts.push(`Document metadata — ${meta.join(', ')}.`, '');

  parts.push('OCR text:', '"""', input.text.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and
 * surrounding prose, validate through the contract schema, and return null
 * (rather than throwing) when nothing parses — a chatty model can't fail the job.
 */
export function parseDocMetaResponse(content: string): ExtractedDocMeta | null {
  const json = extractJsonObject(content);
  if (!json || Object.keys(json).length === 0) return null;
  const parsed = extractedDocMetaSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Recover the JSON object from an LLM reply: tolerate code-fence wrapping and
 * surrounding prose. Returns {} (→ null docMeta) rather than throwing when
 * nothing parses.
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
