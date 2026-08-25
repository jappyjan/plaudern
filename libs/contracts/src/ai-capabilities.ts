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

/** Sparse per-capability values stored as an override of the shared group. */
export const aiCapabilityOverrideSchema = z.object({
  /** null inherits the group's provider. */
  providerId: z.string().uuid().nullable(),
  /** null inherits the group or registry model. */
  model: z.string().nullable(),
  /** null inherits the group or registry timeout. */
  timeoutMs: z.number().int().positive().nullable(),
  /** null means there is no stored row; false is an explicit disable. */
  enabled: z.boolean().nullable(),
  params: z.record(z.string(), z.unknown()),
});
export type AiCapabilityOverrideDto = z.infer<typeof aiCapabilityOverrideSchema>;

export const aiCapabilityValueSourceSchema = z.enum(['capability', 'group', 'registry']);
export type AiCapabilityValueSource = z.infer<typeof aiCapabilityValueSourceSchema>;

export const aiCapabilityInactiveReasonSchema = z.enum([
  'explicitly-disabled',
  'group-disabled',
  'opt-in-required',
  'no-provider',
  'provider-unavailable',
  'incompatible-provider',
  'no-model',
]);
export type AiCapabilityInactiveReason = z.infer<typeof aiCapabilityInactiveReasonSchema>;

/** Fully resolved, non-secret values the backend will use for this capability. */
export const effectiveAiCapabilitySettingSchema = z.object({
  providerId: z.string().uuid().nullable(),
  providerSource: aiCapabilityValueSourceSchema.nullable(),
  model: z.string().nullable(),
  modelSource: aiCapabilityValueSourceSchema,
  timeoutMs: z.number().int().positive(),
  params: z.record(z.string(), z.unknown()),
});
export type EffectiveAiCapabilitySettingDto = z.infer<
  typeof effectiveAiCapabilitySettingSchema
>;

/** Per-user override and backend-resolved state for one capability. */
export const aiCapabilitySettingSchema = z.object({
  capability: aiCapabilitySchema,
  override: aiCapabilityOverrideSchema,
  effective: effectiveAiCapabilitySettingSchema,
  /**
   * Whether the capability currently resolves to a usable provider. The reason
   * is populated whenever this is false so callers do not reconstruct policy.
   */
  active: z.boolean(),
  inactiveReason: aiCapabilityInactiveReasonSchema.nullable(),
});
export type AiCapabilitySettingDto = z.infer<typeof aiCapabilitySettingSchema>;

export const aiCapabilitiesResponseSchema = z.object({
  catalog: z.array(aiCapabilityCatalogEntrySchema),
  settings: z.array(aiCapabilitySettingSchema),
});
export type AiCapabilitiesResponseDto = z.infer<typeof aiCapabilitiesResponseSchema>;

export const updateAiCapabilityRequestSchema = z.object({
  /** null removes the provider override and inherits the group provider. */
  providerId: z.string().uuid().nullable(),
  model: z.string().max(200).nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAiCapabilityRequest = z.infer<typeof updateAiCapabilityRequestSchema>;

/* ---- Capability *groups* (the simplified, kind-level settings) ------------ *
 * Instead of configuring all 22 capabilities individually, the primary UI
 * exposes one shared setting per capability *kind* (Reasoning/Chat, Vision/OCR,
 * Embeddings, Transcription, Diarization). A group's provider+model+params
 * applies to every member capability that has no per-task override. Per-task
 * overrides remain available (Advanced) via the `updateAiCapability` endpoints.
 */

/** A user's shared setting for one capability kind, plus catalog metadata. */
export const aiCapabilityGroupSchema = z.object({
  kind: aiCapabilityKindSchema,
  label: z.string(),
  description: z.string(),
  /** Provider protocols any member of this group can speak. */
  compatibleProtocols: z.array(aiProviderProtocolSchema),
  defaultModel: z.string().nullable(),
  defaultBaseUrl: z.string().nullable(),
  /** Tunable params for this group (only single-member kinds have any). */
  params: z.array(aiCapabilityParamDescriptorSchema),
  /** Chosen provider connection id, or null when unconfigured (⇒ disabled). */
  providerId: z.string().uuid().nullable(),
  /** Shared model; null falls back to the group's default. */
  model: z.string().nullable(),
  /** Shared request timeout override in ms; null falls back to the default. */
  timeoutMs: z.number().int().positive().nullable(),
  /** Shared param values (see the `params` descriptors). */
  paramValues: z.record(z.string(), z.unknown()),
  /** User toggle to switch the whole group off without unassigning. */
  enabled: z.boolean(),
  /** Whether the group currently resolves to a usable provider. */
  active: z.boolean(),
  /** Every capability this group covers, in display order. */
  memberCapabilities: z.array(aiCapabilitySchema),
  /** Members the user has overridden away from the shared setting (Advanced). */
  overriddenCapabilities: z.array(aiCapabilitySchema),
});
export type AiCapabilityGroupDto = z.infer<typeof aiCapabilityGroupSchema>;

export const aiCapabilityGroupsResponseSchema = z.object({
  groups: z.array(aiCapabilityGroupSchema),
  /** The per-capability catalog + settings, for the Advanced per-task view. */
  catalog: z.array(aiCapabilityCatalogEntrySchema),
  settings: z.array(aiCapabilitySettingSchema),
});
export type AiCapabilityGroupsResponseDto = z.infer<typeof aiCapabilityGroupsResponseSchema>;

export const updateAiCapabilityGroupRequestSchema = z.object({
  /** null unassigns the provider (disables the group). */
  providerId: z.string().uuid().nullable(),
  model: z.string().max(200).nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAiCapabilityGroupRequest = z.infer<typeof updateAiCapabilityGroupRequestSchema>;
