import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AiProviderCallDto, AuditLogListResponse } from '@plaudern/contracts';
import { AiProviderCallEntity } from '@plaudern/persistence';

/**
 * Read/maintenance access to the AI-provider audit log (JJ-42). Strictly
 * user-scoped: every query filters on `userId`, so one user can never read (or
 * clear) another's trail.
 */
@Injectable()
export class AuditPersistenceService {
  constructor(
    @InjectRepository(AiProviderCallEntity)
    private readonly calls: Repository<AiProviderCallEntity>,
  ) {}

  /** One page of the user's audit log, newest first. */
  async list(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<AuditLogListResponse> {
    const [rows, total] = await this.calls.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      entries: rows.map(toDto),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
    };
  }

  /** Delete every audit row for a user (used by panic-delete). Returns count. */
  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.calls.delete({ userId });
    return result.affected ?? 0;
  }
}

/** Map a row to its DTO. `bytesSent` is a Postgres bigint (string) — coerce. */
export function toDto(row: AiProviderCallEntity): AiProviderCallDto {
  return {
    id: row.id,
    itemId: row.inboxItemId,
    kind: row.kind,
    provider: row.provider,
    endpoint: row.endpoint,
    direction: row.direction,
    bytesSent: Number(row.bytesSent),
    contentHash: row.contentHash,
    hasPayload: row.payloadRedacted != null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
