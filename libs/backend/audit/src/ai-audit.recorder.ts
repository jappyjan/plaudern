import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AiProviderCallDirection } from '@plaudern/contracts';
import { AiProviderCallEntity } from '@plaudern/persistence';
import { getAiAuditContext, type AiAuditContext } from './ai-audit.context';

/** Longest redacted-payload copy kept under the opt-in (chars). */
const MAX_REDACTED_PAYLOAD_CHARS = 20_000;

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
          payloadRedacted: this.storePayload ? redact(buffer) : null,
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

/** UTF-8 view of the payload, truncated to the opt-in cap. */
function redact(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.length > MAX_REDACTED_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_REDACTED_PAYLOAD_CHARS)}…[truncated]`
    : text;
}
