import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { McpTokenCreatedDto, McpTokenStatusDto } from '@plaudern/contracts';
import { McpTokenEntity } from '@plaudern/persistence';

/** Human-recognizable prefix so `mcp_…` reads as an MCP credential at a glance. */
const TOKEN_PREFIX = 'mcp_';
/** Characters of the plaintext kept for display (`mcp_ab12`). */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;
/** Refresh lastUsedAt at most this often — not on every request. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Owns the per-user MCP token — exactly one row per user (mirrors
 * EmailSettingsService). The token is the Bearer credential MCP clients present
 * to `/api/mcp`; minting it hands back the plaintext exactly once (only the
 * sha256 hash is stored, like an auth session), rotating replaces it so the old
 * one stops working immediately, and revoking deletes the row.
 */
@Injectable()
export class McpTokenService {
  constructor(
    @InjectRepository(McpTokenEntity)
    private readonly repo: Repository<McpTokenEntity>,
  ) {}

  getEntity(userId: string): Promise<McpTokenEntity | null> {
    return this.repo.findOne({ where: { userId } });
  }

  toStatusDto(entity: McpTokenEntity | null): McpTokenStatusDto {
    if (!entity) {
      return { configured: false, tokenPrefix: null, createdAt: null, lastUsedAt: null };
    }
    return {
      configured: true,
      tokenPrefix: entity.tokenPrefix,
      createdAt: entity.createdAt.toISOString(),
      lastUsedAt: entity.lastUsedAt,
    };
  }

  /**
   * Create (first call) or rotate (subsequent calls) the user's token, returning
   * the plaintext — the only time it is ever exposed. A rotate invalidates the
   * previous token immediately (no grace period, like rotating any credential).
   */
  async mint(userId: string): Promise<McpTokenCreatedDto> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const tokenPrefix = token.slice(0, DISPLAY_PREFIX_LENGTH);
    const existing = await this.getEntity(userId);

    const entity = existing ?? this.repo.create({ userId });
    entity.tokenHash = hashToken(token);
    entity.tokenPrefix = tokenPrefix;
    entity.lastUsedAt = null;
    const saved = await this.repo.save(entity);

    return { ...this.toStatusDto(saved), token };
  }

  /** Revoke the user's token (a no-op if none exists). */
  async revoke(userId: string): Promise<void> {
    await this.repo.delete({ userId });
  }

  /**
   * Resolve a presented Bearer token to its owning user id, or null for an
   * unknown/revoked token. Bumps `lastUsedAt` at most hourly so the settings UI
   * can show recency without a write on every MCP call.
   */
  async resolveUserId(token: string): Promise<string | null> {
    const actor = await this.resolveActor(token);
    return actor?.userId ?? null;
  }

  /**
   * Resolve a presented Bearer token to its owning user id AND the token's
   * non-secret display prefix, or null for an unknown/revoked token. The prefix
   * identifies WHICH token acted (for the mutation audit trail) without being
   * able to reconstruct the secret. Bumps `lastUsedAt` at most hourly, like
   * `resolveUserId`.
   */
  async resolveActor(token: string): Promise<{ userId: string; tokenPrefix: string } | null> {
    if (!token) return null;
    const entity = await this.repo.findOne({ where: { tokenHash: hashToken(token) } });
    if (!entity) return null;

    const now = Date.now();
    if (!entity.lastUsedAt || now - Date.parse(entity.lastUsedAt) > LAST_USED_THROTTLE_MS) {
      await this.repo.update({ id: entity.id }, { lastUsedAt: new Date(now).toISOString() });
    }
    return { userId: entity.userId, tokenPrefix: entity.tokenPrefix };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
