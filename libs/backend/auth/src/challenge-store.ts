import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CHALLENGE_TTL_MS } from './auth.config';

export interface PendingChallenge {
  challenge: string;
  /** Registration only: the username the options were generated for. */
  username?: string;
  /** Registration only: the WebAuthn user handle baked into the options. */
  webauthnUserId?: string;
  /** Add-passkey only: the already-authenticated user this ceremony extends. */
  userId?: string;
  expiresAt: number;
}

/**
 * Holds in-flight WebAuthn challenges between the options and verify calls,
 * keyed by a random id carried in a short-lived cookie. In-memory on purpose:
 * challenges live for five minutes and the app is single-instance by design
 * (same assumption as the sync mutexes and the SSE fan-out).
 */
@Injectable()
export class ChallengeStore {
  private readonly pending = new Map<string, PendingChallenge>();

  put(data: Omit<PendingChallenge, 'expiresAt'>): string {
    this.prune();
    const id = randomBytes(16).toString('base64url');
    this.pending.set(id, { ...data, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return id;
  }

  /** One-shot: a challenge can only ever be consumed once. */
  take(id: string | undefined): PendingChallenge | null {
    if (!id) return null;
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    return entry.expiresAt > Date.now() ? entry : null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }
}
