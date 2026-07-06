import { z } from 'zod';

/**
 * The wire protocol an AI provider connection speaks. Determines which client
 * the backend uses and how it authenticates:
 * - `openai-compatible`: any `/chat/completions` + `/embeddings` server
 *   (DeepSeek, OpenAI, OpenRouter, Perplexity, Ollama, llama.cpp, …). Bearer key.
 * - `elevenlabs`: ElevenLabs Scribe speech-to-text (`xi-api-key` header).
 * - `whisper`: a self-hosted OpenAI-compatible `/audio/transcriptions` server.
 * - `pyannoteai`: the pyannoteAI diarization/voiceprint API.
 */
export const aiProviderProtocolSchema = z.enum([
  'openai-compatible',
  'elevenlabs',
  'whisper',
  'pyannoteai',
]);
export type AiProviderProtocol = z.infer<typeof aiProviderProtocolSchema>;

/**
 * A saved provider *connection* (credentials) as exposed to the client. The API
 * key is write-only — responses only ever carry `hasApiKey` and a masked hint,
 * mirroring how Plaud settings expose `hasPassword`.
 */
export const aiProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  protocol: aiProviderProtocolSchema,
  baseUrl: z.string(),
  /** True once an API key has been stored (keyless local endpoints have none). */
  hasApiKey: z.boolean(),
  /** Last few characters of the stored key, for recognition only (or null). */
  apiKeyHint: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AiProviderDto = z.infer<typeof aiProviderSchema>;

export const aiProviderListSchema = z.object({
  providers: z.array(aiProviderSchema),
});
export type AiProviderListDto = z.infer<typeof aiProviderListSchema>;

export const createAiProviderRequestSchema = z.object({
  name: z.string().min(1).max(120),
  protocol: aiProviderProtocolSchema,
  baseUrl: z.string().min(1).max(2000),
  /** Omit or empty for keyless local endpoints (Ollama, llama.cpp, …). */
  apiKey: z.string().max(4000).optional(),
});
export type CreateAiProviderRequest = z.infer<typeof createAiProviderRequestSchema>;

export const updateAiProviderRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  protocol: aiProviderProtocolSchema.optional(),
  baseUrl: z.string().min(1).max(2000).optional(),
  /**
   * Omitted => keep the stored key. Empty string => clear the key (make it
   * keyless). A non-empty value replaces it.
   */
  apiKey: z.string().max(4000).optional(),
});
export type UpdateAiProviderRequest = z.infer<typeof updateAiProviderRequestSchema>;
