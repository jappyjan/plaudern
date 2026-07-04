import { z } from 'zod';

/**
 * Authentication is passkey-only (WebAuthn). The option/response payloads of
 * the WebAuthn ceremonies are treated as opaque JSON here — their shape is
 * owned by the @simplewebauthn packages on both sides of the wire; contracts
 * only pin the envelope.
 */

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'username must be at least 3 characters')
  .max(32, 'username must be at most 32 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'username may contain lowercase letters, digits, ".", "_" and "-"',
  );

export const authUserSchema = z.object({
  // Every account — including the very first (owner) one — has a real random
  // UUID. The old build gave the owner a fixed sentinel id, which this schema
  // deliberately rejects: `.uuid()` (RFC 9562) is the invariant the backend
  // must honour, not something to relax.
  id: z.string().uuid(),
  username: z.string(),
});
export type AuthUserDto = z.infer<typeof authUserSchema>;

/** Pre-login probe the web app uses to decide which screen to show. */
export const authStatusSchema = z.object({
  /** False on a fresh install — the login page offers "create account" first. */
  usersExist: z.boolean(),
  allowRegistration: z.boolean(),
  /** True when AUTH_DISABLED=true restores the old single-user no-auth mode. */
  authDisabled: z.boolean(),
});
export type AuthStatusDto = z.infer<typeof authStatusSchema>;

export const meResponseSchema = z.object({ user: authUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const registerOptionsRequestSchema = z.object({ username: usernameSchema });

/** The authenticator's answer, passed through verbatim to the server. */
export const webauthnVerifyRequestSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  /** Optional user-facing name for the new passkey (registration only). */
  label: z.string().trim().min(1).max(64).optional(),
});

export const passkeySchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  /** 'singleDevice' | 'multiDevice' (synced passkey). */
  deviceType: z.string(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PasskeyDto = z.infer<typeof passkeySchema>;

export const passkeyListResponseSchema = z.object({
  passkeys: z.array(passkeySchema),
});
export type PasskeyListResponse = z.infer<typeof passkeyListResponseSchema>;
