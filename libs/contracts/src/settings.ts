import { z } from 'zod';

/** Plaud cloud region — must match the account's region or auth fails. */
export const plaudRegionSchema = z.enum(['us', 'eu']);
export type PlaudRegion = z.infer<typeof plaudRegionSchema>;

export const plaudSyncStatusSchema = z.enum(['ok', 'error']);
export type PlaudSyncStatus = z.infer<typeof plaudSyncStatusSchema>;

/**
 * Plaud integration settings as exposed to the client. The stored password is
 * write-only: responses only ever carry `hasPassword`.
 */
export const plaudSettingsSchema = z.object({
  /** True once credentials have been saved at least once. */
  configured: z.boolean(),
  enabled: z.boolean(),
  email: z.string().nullable(),
  region: plaudRegionSchema.nullable(),
  hasPassword: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: plaudSyncStatusSchema.nullable(),
  lastSyncError: z.string().nullable(),
  lastSyncImportedCount: z.number().int().nullable(),
  syncRunning: z.boolean(),
});
export type PlaudSettingsDto = z.infer<typeof plaudSettingsSchema>;

export const updatePlaudSettingsRequestSchema = z.object({
  email: z.email(),
  /** Omitted => keep the currently stored password (required on first save). */
  password: z.string().min(1).optional(),
  region: plaudRegionSchema,
  enabled: z.boolean(),
});
export type UpdatePlaudSettingsRequest = z.infer<typeof updatePlaudSettingsRequestSchema>;

/** Absent fields fall back to the stored credentials. */
export const plaudTestConnectionRequestSchema = z.object({
  email: z.email().optional(),
  password: z.string().min(1).optional(),
  region: plaudRegionSchema.optional(),
});
export type PlaudTestConnectionRequest = z.infer<typeof plaudTestConnectionRequestSchema>;

export const plaudTestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type PlaudTestConnectionResponse = z.infer<typeof plaudTestConnectionResponseSchema>;

export const plaudSyncNowResponseSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
});
export type PlaudSyncNowResponse = z.infer<typeof plaudSyncNowResponseSchema>;
