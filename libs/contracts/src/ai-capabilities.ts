import { z } from 'zod';
import { aiProviderProtocolSchema } from './ai-providers';

/**
 * Every AI capability the app can perform. Each maps to exactly one provider
 * class in the backend and, per user, to one `ai_capability_settings` row that
 * picks which provider connection + model powers it. Add a new capability here
 * and in the backend registry (`libs/backend/ai-config`) — never a new env var.
 */
export const aiCapabilitySchema = z.enum([
  'summarization',
  'embeddings',
  'ocr',
  'entity_extraction',
  'entity_relations',
  'entity_judge',
  'contact_resolution',
  'web_research',
  'topics',
  'topic_docs',
  'journal',
  'commitments',
  'questions',
  'tasks',
  'decisions',
  'reminders',
  'facts',
  'docmeta',
  'chat',
  'verification',
  'transcription',
  'speaker_id',
]);
export type AiCapability = z.infer<typeof aiCapabilitySchema>;

/**
 * The shape of provider a capability needs. Used to filter which provider
 * connections can be assigned to it in the UI.
 */
export const aiCapabilityKindSchema = z.enum([
  'chat',
  'vision',
  'embeddings',
  'stt',
  'diarization',
]);
export type AiCapabilityKind = z.infer<typeof aiCapabilityKindSchema>;

/** One tunable, capability-specific parameter (rendered generically in the UI). */
export const aiCapabilityParamDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['number', 'boolean', 'string']),
  description: z.string().nullable(),
  placeholder: z.string().nullable(),
});
export type AiCapabilityParamDescriptor = z.infer<typeof aiCapabilityParamDescriptorSchema>;

/** Static metadata about a capability, for rendering the settings UI. */
export const aiCapabilityCatalogEntrySchema = z.object({
  capability: aiCapabilitySchema,
  label: z.string(),
  description: z.string(),
  kind: aiCapabilityKindSchema,
  /** Provider protocols that can power this capability. */
  compatibleProtocols: z.array(aiProviderProtocolSchema),
  defaultModel: z.string().nullable(),
  defaultBaseUrl: z.string().nullable(),
  /** Off unless the user opts in (only `web_research` today). */
  optIn: z.boolean(),
  params: z.array(aiCapabilityParamDescriptorSchema),
});
export type AiCapabilityCatalogEntry = z.infer<typeof aiCapabilityCatalogEntrySchema>;

/** Per-user assignment of a capability to a provider connection. */
export const aiCapabilitySettingSchema = z.object({
  capability: aiCapabilitySchema,
  /** Chosen provider connection id, or null when unconfigured (⇒ disabled). */
  providerId: z.string().uuid().nullable(),
  /** Model override; null falls back to the capability's default. */
  model: z.string().nullable(),
  /** Request timeout override in ms; null falls back to the default. */
  timeoutMs: z.number().int().positive().nullable(),
  /** User toggle to switch the capability off without unassigning the provider. */
  enabled: z.boolean(),
  /** Capability-specific params (see the catalog descriptors). */
  params: z.record(z.string(), z.unknown()),
  /**
   * Whether the capability currently resolves to a usable provider — the
   * DB-settings equivalent of the old "API key present" gate.
   */
  active: z.boolean(),
});
export type AiCapabilitySettingDto = z.infer<typeof aiCapabilitySettingSchema>;

export const aiCapabilitiesResponseSchema = z.object({
  catalog: z.array(aiCapabilityCatalogEntrySchema),
  settings: z.array(aiCapabilitySettingSchema),
});
export type AiCapabilitiesResponseDto = z.infer<typeof aiCapabilitiesResponseSchema>;

export const updateAiCapabilityRequestSchema = z.object({
  /** null unassigns the provider (disables the capability). */
  providerId: z.string().uuid().nullable(),
  model: z.string().max(200).nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAiCapabilityRequest = z.infer<typeof updateAiCapabilityRequestSchema>;
