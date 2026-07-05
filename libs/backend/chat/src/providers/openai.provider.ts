import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import type {
  ChatCompletionMessage,
  ChatCompletionProvider,
  ChatCompletionResult,
} from '../chat.provider';

/**
 * Memory chat via an OpenAI-compatible `/chat/completions` endpoint. The
 * endpoint/model come from the user's DB-backed AI config
 * (`@plaudern/ai-config`, capability `chat`, which inherits from
 * `summarization` at resolve time) — any provider exposing the OpenAI schema
 * works (DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp server, …).
 * Only retrieved text passages are sent, never audio.
 */
@Injectable()
export class OpenAiChatCompletionProvider implements ChatCompletionProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async complete(
    userId: string,
    messages: ChatCompletionMessage[],
  ): Promise<ChatCompletionResult> {
    const config = await this.aiConfig.resolve(userId, 'chat');
    if (!config) {
      throw new Error(
        'memory chat is not configured — assign a provider to the chat capability ' +
          'in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
    });
    return { content: this.chat.contentOf(response), model: response.model ?? config.model };
  }
}
