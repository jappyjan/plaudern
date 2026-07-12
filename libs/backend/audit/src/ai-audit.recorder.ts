import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AiProviderCallDirection } from '@plaudern/contracts';
import { AiProviderCallEntity } from '@plaudern/persistence';
import { getAiAuditContext, type AiAuditContext } from './ai-audit.context';

/** Longest stored-payload copy kept under the opt-in (chars). */
const MAX_STORED_PAYLOAD_CHARS = 20_000;

export interface RecordAiCallParams {
  /** Provider id, e.g. `elevenlabs-scribe`, `pyannoteai`, `openai:deepseek-chat`. */
  provider: string;
  /** Full URL or host+path the bytes were sent to. Query string is stripped. */
  endpoint: string;
  /** The payload sent — a string or Buffer. Hashed + sized; never stored raw. */
  payload: string | Buffer;
  direction?: AiProviderCallDirection;
  /**
   * Explicit attribution, used when there is no ambient AsyncLocalStorage
   * context (rare). Normally left unset — the recorder reads the context the
   * processor established.
   */
  context?: AiAuditContext;
}

/** One audited MCP mutation — an external agent WRITING to the user's memory. */
export interface RecordMcpMutationParams {
  userId: string;
  /** Display prefix of the acting MCP token (e.g. `mcp_ab12`); never the secret. */
  tokenPrefix: string;
  /** The mutation tool invoked, e.g. `create_task`. */
  tool: string;
  /** The inbox item the mutation touched, when item-scoped; null otherwise. */
  itemId?: string | null;
  /** A small JSON-serializable description of WHAT changed (ids, from/to status, …). */
  change: Record<string, unknown>;
}

/**
 * Records one audited external AI-provider call (JJ-42).
 *
 * The recorder is the single seam every provider adapter calls after it decides
 * what to send. It reads the ambient {user, item, kind} attribution
 * (AsyncLocalStorage, set by the processor), computes the payload SIZE and a
 * SHA-256 CONTENT HASH, and persists a metadata row — never the payload itself,
 * unless the operator set `AI_AUDIT_STORE_PAYLOAD=true`, in which case a
 * truncated copy is also kept for debugging.
 *
 * Failures to record are swallowed (logged): auditing must never break the
 * provider call it is observing. A call made outside any audit context is
 * skipped with a warning rather than attributed to the wrong user.
 */
@Injectable()
export class AiAuditRecorder {
  private readonly logger = new Logger(AiAuditRecorder.name);
  private readonly storePayload: boolean;

  constructor(
    @InjectRepository(AiProviderCallEntity)
    private readonly calls: Repository<AiProviderCallEntity>,
    config: ConfigService,
  ) {
    this.storePayload = config.get<string>('AI_AUDIT_STORE_PAYLOAD', 'false') === 'true';
  }

  /**
   * Record one audited MCP MUTATION (JJ-78 follow-up) into the SAME
   * `ai_provider_calls` trail the AI-egress log uses, so the user has one place
   * to see everything that acted on their memory. An MCP mutation is not an AI
   * call, so the fields are reinterpreted: `provider` is the literal `mcp`,
   * `endpoint` carries the acting token's non-secret display prefix (WHICH token
   * acted), `kind` is `mcp:<tool>`, `direction` is `inbound` (an external agent
   * writing IN, vs. our bytes going `outbound` to a provider), and the hashed
   * `change` payload records WHAT changed (ids + from/to status). Like `record`,
   * failures are swallowed (logged) — auditing must never break the mutation it
   * observes — and the raw change is stored only under the `AI_AUDIT_STORE_PAYLOAD`
   * operator opt-in. Called AFTER the mutation commits, so the trail only ever
   * reflects changes that actually landed.
   */
  async recordMcpMutation(params: RecordMcpMutationParams): Promise<void> {
    try {
      const payload = JSON.stringify(params.change);
      const buffer = Buffer.from(payload, 'utf8');
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      await this.calls.save(
        this.calls.create({
          userId: params.userId,
          inboxItemId: params.itemId ?? null,
          kind: `mcp:${params.tool}`,
          provider: 'mcp',
          endpoint: params.tokenPrefix,
          direction: 'inbound',
          bytesSent: buffer.byteLength,
          contentHash,
          payloadRedacted: this.storePayload
            ? truncateForStorage(payload, buffer.byteLength)
            : null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `failed to record MCP mutation audit for ${params.tool}: ${(err as Error).message}`,
      );
    }
  }

  async record(params: RecordAiCallParams): Promise<void> {
    try {
      const context = params.context ?? getAiAuditContext();
      if (!context?.userId) {
        // No attribution — recording it would either lose the user or guess.
        // Skip loudly so the gap is visible without failing the provider call.
        this.logger.warn(
          `skipping audit for ${params.provider} — no audit context on the call stack`,
        );
        return;
      }

      const buffer = Buffer.isBuffer(params.payload)
        ? params.payload
        : Buffer.from(params.payload, 'utf8');
      const contentHash = createHash('sha256').update(buffer).digest('hex');

      await this.calls.save(
        this.calls.create({
          userId: context.userId,
          inboxItemId: context.itemId ?? null,
          kind: context.kind,
          provider: params.provider,
          endpoint: sanitizeEndpoint(params.endpoint),
          direction: params.direction ?? 'outbound',
          bytesSent: buffer.byteLength,
          contentHash,
          payloadRedacted: this.storePayload
            ? truncateForStorage(params.payload, buffer.byteLength)
            : null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `failed to record audit for ${params.provider}: ${(err as Error).message}`,
      );
    }
  }
}

/** Drop the query string (may carry keys/signatures) so the log stays clean. */
function sanitizeEndpoint(endpoint: string): string {
  const q = endpoint.indexOf('?');
  return q >= 0 ? endpoint.slice(0, q) : endpoint;
}

/**
 * Opt-in debugging copy of the payload. This TRUNCATES to a cap; it does NOT
 * scrub PII — enabling `AI_AUDIT_STORE_PAYLOAD` accepts storing real content.
 * Binary payloads (e.g. audio Buffers sent to transcription/diarization) are
 * stored as a size placeholder rather than a lossy UTF-8 mangling.
 */
function truncateForStorage(payload: string | Buffer, byteLength: number): string {
  if (Buffer.isBuffer(payload)) return `[binary payload, ${byteLength} bytes]`;
  return payload.length > MAX_STORED_PAYLOAD_CHARS
    ? `${payload.slice(0, MAX_STORED_PAYLOAD_CHARS)}…[truncated]`
    : payload;
}
