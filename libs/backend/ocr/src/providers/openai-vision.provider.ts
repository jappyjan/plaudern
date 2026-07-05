import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type { OcrInput, OcrProvider, OcrResult } from '../ocr.provider';

/**
 * OCR via an OpenAI-compatible `/chat/completions` endpoint using a
 * VISION-capable model: the document image is sent as an `image_url` data URL
 * and the model transcribes its full text.
 *
 * The endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `ocr`) — any provider exposing the OpenAI
 * vision schema works. The configured model MUST be vision-capable; if it can't
 * do vision the request errors and the processor marks the item failed — it
 * never hard-crashes the pipeline.
 */
@Injectable()
export class OpenAiVisionOcrProvider implements OcrProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async recognize(userId: string, input: OcrInput): Promise<OcrResult> {
    const config = await this.aiConfig.resolve(userId, 'ocr');
    if (!config) {
      throw new Error(
        'OCR is not configured — add an AI provider and assign it to the ocr capability ' +
          'in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
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
    });
    const text = this.chat.contentOf(response).trim();
    return { text, model: response.model ?? config.model, raw: response };
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
