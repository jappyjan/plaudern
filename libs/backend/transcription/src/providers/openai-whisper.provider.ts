import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';

/**
 * OpenAI audio transcription (plan §5). Buffers the stream and posts it as
 * multipart/form-data to the transcriptions endpoint. Model + base URL are
 * configurable so a compatible endpoint can be substituted.
 */
@Injectable()
export class OpenAiWhisperProvider implements TranscriptionProvider {
  readonly id = 'whisper-openai';
  private readonly logger = new Logger(OpenAiWhisperProvider.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('OPENAI_API_KEY', '');
    this.model = config.get<string>('TRANSCRIPTION_MODEL', 'whisper-1');
    this.baseUrl = config.get<string>('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of input.stream) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    const form = new FormData();
    const blob = new Blob([buffer], { type: input.contentType });
    form.append('file', blob, input.filename ?? 'audio');
    form.append('model', this.model);
    if (input.languageHint) form.append('language', input.languageHint);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`transcription failed: ${res.status} ${body}`);
      throw new Error(`transcription provider error ${res.status}`);
    }

    const json = (await res.json()) as { text: string; language?: string };
    return { text: json.text, language: json.language, raw: json };
  }
}
