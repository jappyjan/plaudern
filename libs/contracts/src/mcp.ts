import { z } from 'zod';

/**
 * MCP (Model Context Protocol) access as exposed to the settings UI. The token
 * itself is write-only — like an API key it is shown exactly once, at mint time,
 * and only its sha256 hash is stored. Responses therefore never carry the secret;
 * they carry a short, non-sensitive `tokenPrefix` so the UI can show *which*
 * token is active without being able to reconstruct it.
 */
export const mcpTokenStatusSchema = z.object({
  /** True once a token has been minted (and not revoked). */
  configured: z.boolean(),
  /** First few characters of the active token (e.g. `mcp_ab12`), for display only. */
  tokenPrefix: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
});
export type McpTokenStatusDto = z.infer<typeof mcpTokenStatusSchema>;

/**
 * The one-time response when a token is minted or rotated. Carries the full
 * plaintext `token` — the only time the server ever returns it — alongside the
 * usual status so the client can immediately show and store it.
 */
export const mcpTokenCreatedSchema = mcpTokenStatusSchema.extend({
  /** The full bearer token, returned only here and never again. */
  token: z.string(),
});
export type McpTokenCreatedDto = z.infer<typeof mcpTokenCreatedSchema>;

/** Bounds for the MCP `search_memory` tool. */
export const MCP_SEARCH_MIN_LIMIT = 1;
export const MCP_SEARCH_MAX_LIMIT = 20;
export const MCP_SEARCH_DEFAULT_LIMIT = 5;

/** Bounds for the MCP `list_recent_items` tool. */
export const MCP_LIST_MIN_LIMIT = 1;
export const MCP_LIST_MAX_LIMIT = 50;
export const MCP_LIST_DEFAULT_LIMIT = 20;
