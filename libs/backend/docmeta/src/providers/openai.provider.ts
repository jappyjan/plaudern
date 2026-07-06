import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractedDocMetaSchema, type ExtractedDocMeta } from '@plaudern/contracts';
import type {
  DocMetaInput,
  DocMetaProvider,
  DocMetaResult,
} from '../docmeta.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Extracts structured document metadata from OCR text via an OpenAI-compatible
 * `/chat/completions` endpoint. Defaults to DeepSeek (`deepseek-chat`) — the
 * cheapest capable text option — since it reads the OCR TEXT, not the image;
 * override DOCMETA_BASE_URL/MODEL for another provider (incl. a local Ollama
 * server), mirroring the reminders/decisions extractors.
 */
@Injectable()
export class OpenAiDocMetaProvider implements DocMetaProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiDocMetaProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('DOCMETA_BASE_URL', 'https://api.deepseek.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('DOCMETA_API_KEY', '');
    this.model = config.get<string>('DOCMETA_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('DOCMETA_TIMEOUT_MS', String(2 * 60_000)));
    this.explicitlyEnabled = config.get<string>('DOCMETA_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async extract(input: DocMetaInput): Promise<DocMetaResult> {
    if (!this.enabled) {
      throw new Error(
        'document-metadata extraction is disabled — set DOCMETA_API_KEY (cloud endpoints) or ' +
          'DOCMETA_ENABLED=true (keyless local endpoints such as Ollama) to enable it',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
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
          `document-metadata request failed: ${res.status} ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      const docMeta = parseDocMetaResponse(content);
      return { docMeta, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
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
  '    "documentDate": the date the document itself is dated (issue/invoice/letter/',
  '        statement date) as YYYY-MM-DD, or null,',
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
  '- "documentDate" is the date the document was issued/written/dated (e.g. the',
  '  invoice date, the letter date, the statement period date) — NOT the scan',
  '  date, NOT a deadline. Resolve it to an absolute YYYY-MM-DD against the scan',
  '  date. If the document has no clear date of its own, use null.',
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
