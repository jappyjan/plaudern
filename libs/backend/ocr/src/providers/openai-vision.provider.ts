import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OcrInput, OcrProvider, OcrResult } from '../ocr.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * OCR via an OpenAI-compatible `/chat/completions` endpoint using a
 * VISION-capable model: the document image is sent as an `image_url` data URL
 * and the model transcribes its full text.
 *
 * This is a NEW LLM kind that ships DISABLED. It must be pointed at a vision
 * model explicitly (OCR_BASE_URL/OCR_MODEL/OCR_API_KEY) because the default
 * summarization tier (DeepSeek) is text-only. Enable with an OCR_API_KEY (cloud)
 * or OCR_ENABLED=true (keyless local gateways such as a llama.cpp/Ollama vision
 * server). If the configured model can't actually do vision the request errors
 * and the processor marks the item failed — it never hard-crashes the pipeline.
 */
@Injectable()
export class OpenAiVisionOcrProvider implements OcrProvider {
  readonly id: string;
  private readonly logger = new Logger(OpenAiVisionOcrProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('OCR_BASE_URL', 'https://api.openai.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('OCR_API_KEY', '');
    this.model = config.get<string>('OCR_MODEL', 'gpt-4o-mini');
    this.timeoutMs = Number(config.get<string>('OCR_TIMEOUT_MS', String(3 * 60_000)));
    this.explicitlyEnabled = config.get<string>('OCR_ENABLED', 'false') === 'true';
    this.id = `openai-vision:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    if (!this.enabled) {
      throw new Error(
        'OCR is disabled — set OCR_API_KEY (cloud vision endpoints) or OCR_ENABLED=true ' +
          '(keyless local vision gateways) and point OCR_BASE_URL/OCR_MODEL at a ' +
          'vision-capable model to enable it',
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
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: USER_PROMPT },
                { type: 'image_url', image_url: { url: input.imageDataUrl } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OCR request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const text = (json.choices?.[0]?.message?.content ?? '').trim();
      return { text, model: json.model ?? this.model, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SYSTEM_PROMPT = [
  'You are an OCR engine. Transcribe ALL text visible in the provided document',
  'image exactly as it appears, preserving reading order and line breaks.',
  'Include printed and handwritten text. Do not summarize, translate, explain,',
  'or add commentary — output ONLY the transcribed text. If the image contains',
  'no legible text, output an empty response.',
].join('\n');

export const USER_PROMPT = 'Transcribe the full text of this document image.';
