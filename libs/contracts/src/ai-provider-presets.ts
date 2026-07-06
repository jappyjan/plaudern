import { z } from 'zod';
import { aiProviderProtocolSchema } from './ai-providers';

/**
 * A known AI vendor, so the "add provider" flow can offer sensible defaults
 * instead of making the user hand-type a protocol and base URL. Picking
 * "DeepSeek" fills in `https://api.deepseek.com/v1` and suggests its models;
 * "Custom" (no preset) falls back to the raw protocol + base-URL fields.
 *
 * `models` is keyed by capability *kind* so each group's model dropdown only
 * shows the models that vendor actually serves for that kind (a chat vendor has
 * no embeddings models, an STT vendor no chat models, …). The list is a
 * convenience — the UI always allows free-text entry for models not listed.
 */
export const aiProviderPresetSchema = z.object({
  /** Stable id stored on the provider connection (`ai_providers.preset`). */
  id: z.string(),
  label: z.string(),
  protocol: aiProviderProtocolSchema,
  defaultBaseUrl: z.string(),
  /** True for local endpoints that need no API key (Ollama, llama.cpp, …). */
  keyless: z.boolean(),
  /** Suggested models per capability kind (only the kinds this vendor serves). */
  models: z.object({
    chat: z.array(z.string()).optional(),
    vision: z.array(z.string()).optional(),
    embeddings: z.array(z.string()).optional(),
    stt: z.array(z.string()).optional(),
    diarization: z.array(z.string()).optional(),
  }),
});
export type AiProviderPreset = z.infer<typeof aiProviderPresetSchema>;

/**
 * The vendor catalog surfaced in the settings UI. Order is display order.
 * `id: 'custom'` is intentionally NOT here — the UI adds a "Custom" choice that
 * clears the preset and reveals the raw protocol/base-URL fields.
 */
export const PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyless: false,
    models: {
      chat: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
      vision: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
      embeddings: ['text-embedding-3-small', 'text-embedding-3-large'],
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyless: false,
    models: {
      chat: ['deepseek-chat', 'deepseek-reasoner'],
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyless: false,
    models: {
      chat: [
        'openai/gpt-4o-mini',
        'anthropic/claude-3.5-sonnet',
        'deepseek/deepseek-chat',
        'google/gemini-2.0-flash-001',
        'meta-llama/llama-3.3-70b-instruct',
      ],
      vision: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    },
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.perplexity.ai',
    keyless: false,
    models: {
      chat: ['sonar', 'sonar-pro', 'sonar-reasoning'],
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyless: false,
    models: {
      chat: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    keyless: false,
    models: {
      chat: ['mistral-large-latest', 'mistral-small-latest'],
      vision: ['pixtral-large-latest'],
      embeddings: ['mistral-embed'],
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyless: true,
    models: {
      chat: ['llama3.2', 'qwen2.5', 'gemma3'],
      vision: ['llama3.2-vision', 'llava'],
      embeddings: ['nomic-embed-text', 'mxbai-embed-large'],
    },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    protocol: 'elevenlabs',
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    keyless: false,
    models: {
      stt: ['scribe_v2', 'scribe_v1'],
    },
  },
  {
    id: 'whisper',
    label: 'Whisper (self-hosted)',
    protocol: 'whisper',
    defaultBaseUrl: '',
    keyless: true,
    models: {
      stt: ['whisper-1'],
    },
  },
  {
    id: 'pyannoteai',
    label: 'pyannoteAI',
    protocol: 'pyannoteai',
    defaultBaseUrl: 'https://api.pyannote.ai/v1',
    keyless: false,
    models: {
      diarization: ['precision-2'],
    },
  },
];

export function providerPreset(id: string | null | undefined): AiProviderPreset | null {
  if (!id) return null;
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}
