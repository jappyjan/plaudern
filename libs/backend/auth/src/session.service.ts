import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { AuthSessionEntity, UserEntity } from '@plaudern/persistence';
import { resolveAuthConfig } from './auth.config';

export interface AuthenticatedUser {
  id: string;
  username: string;
}

/** Refresh lastUsedAt at most this often — not on every request. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Opaque bearer sessions behind the cookie: the cookie value is 32 random
 * bytes (base64url); the database stores only its sha256, so leaked rows
 * cannot be replayed as sessions.
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(AuthSessionEntity)
    private readonly sessions: Repository<AuthSessionEntity>,
    private readonly config: ConfigService,
  ) {}

  async createSession(userId: string): Promise<{ token: string; maxAgeMs: number }> {
    const { sessionTtlMs } = resolveAuthConfig(this.config);
    const token = randomBytes(32).toString('base64url');
    await this.sessions.save(
      this.sessions.create({
        tokenHash: hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
      }),
    );
    // Opportunistic cleanup so expired rows never pile up.
    await this.sessions.delete({ expiresAt: LessThanOrEqual(new Date().toISOString()) });
    return { token, maxAgeMs: sessionTtlMs };
  }

  /** Resolve a cookie token to its user; null for unknown/expired sessions. */
  async resolveUser(token: string): Promise<AuthenticatedUser | null> {
    const session = await this.sessions.findOne({
      where: { tokenHash: hashToken(token) },
      relations: { user: true },
    });
    if (!session || !session.user) return null;
    const now = new Date();
    if (session.expiresAt <= now.toISOString()) {
      await this.sessions.delete({ id: session.id });
      return null;
    }
    if (!session.lastUsedAt || now.getTime() - Date.parse(session.lastUsedAt) > LAST_USED_THROTTLE_MS) {
      await this.sessions.update({ id: session.id }, { lastUsedAt: now.toISOString() });
    }
    return toAuthenticatedUser(session.user);
  }

  async deleteByToken(token: string): Promise<void> {
    await this.sessions.delete({ tokenHash: hashToken(token) });
  }
}

export function toAuthenticatedUser(user: UserEntity): AuthenticatedUser {
  return { id: user.id, username: user.username };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
