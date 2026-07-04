import { z } from 'zod';

/**
 * Email-in settings as exposed to the client (plan §2, `sources/email`). Unlike
 * the Plaud password, the token is not write-only: the whole point is a stable
 * address the user can see and copy, so `address` is always derivable once a
 * token exists (see EmailSettingsService — the token is stored encrypted, not
 * just hashed, precisely so it can be redisplayed).
 */
export const emailSettingsSchema = z.object({
  /** True once an inbound address has been generated at least once. */
  configured: z.boolean(),
  /** Whether inbound email is currently accepted; the address itself never changes. */
  enabled: z.boolean(),
  /** Full `inbox+<token>@<domain>` address, or null if not configured yet. */
  address: z.string().nullable(),
});
export type EmailSettingsDto = z.infer<typeof emailSettingsSchema>;

export const updateEmailSettingsRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateEmailSettingsRequest = z.infer<typeof updateEmailSettingsRequestSchema>;
