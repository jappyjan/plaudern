import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  authStatusSchema,
  meResponseSchema,
  passkeyListResponseSchema,
  passkeySchema,
  type AuthStatusDto,
  type AuthUserDto,
  type PasskeyDto,
  type PasskeyListResponse,
} from '@plaudern/contracts';
import { ApiError, requestJson, requestVoid } from './api';

/**
 * Passkey (WebAuthn) client. Each ceremony asks the server for options,
 * hands them to the browser's credential API, and posts the authenticator's
 * answer back for verification. Sessions live in an httpOnly cookie, so
 * nothing is stored client-side.
 */

export async function getAuthStatus(): Promise<AuthStatusDto> {
  return authStatusSchema.parse(await requestJson('/auth/status'));
}

/** The signed-in user, or null when there is no (valid) session. */
export async function getMe(): Promise<AuthUserDto | null> {
  try {
    return meResponseSchema.parse(await requestJson('/auth/me')).user;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) return null;
    throw cause;
  }
}

/** Usernameless sign-in via a discoverable passkey. */
export async function loginWithPasskey(): Promise<AuthUserDto> {
  const { options } = (await requestJson('/auth/login/options', { method: 'POST' })) as {
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  };
  const response = await startAuthentication({ optionsJSON: options });
  const verified = await requestJson('/auth/login/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
  return meResponseSchema.parse(verified).user;
}

/** Create a brand-new, fully isolated account secured by a passkey. */
export async function registerWithPasskey(username: string): Promise<AuthUserDto> {
  const { options } = (await requestJson('/auth/register/options', {
    method: 'POST',
    body: JSON.stringify({ username }),
  })) as { options: Parameters<typeof startRegistration>[0]['optionsJSON'] };
  const response = await startRegistration({ optionsJSON: options });
  const verified = await requestJson('/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
  return meResponseSchema.parse(verified).user;
}

/** Register an additional passkey (e.g. another device) for this account. */
export async function addPasskey(label?: string): Promise<PasskeyDto> {
  const { options } = (await requestJson('/auth/passkeys/options', { method: 'POST' })) as {
    options: Parameters<typeof startRegistration>[0]['optionsJSON'];
  };
  const response = await startRegistration({ optionsJSON: options });
  return passkeySchema.parse(
    await requestJson('/auth/passkeys/verify', {
      method: 'POST',
      body: JSON.stringify({ response, label: label || undefined }),
    }),
  );
}

export async function listPasskeys(): Promise<PasskeyListResponse> {
  return passkeyListResponseSchema.parse(await requestJson('/auth/passkeys'));
}

export async function deletePasskey(id: string): Promise<void> {
  return requestVoid(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function logout(): Promise<void> {
  return requestVoid('/auth/logout', { method: 'POST' });
}
