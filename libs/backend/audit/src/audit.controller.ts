import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { auditLogListQuerySchema, type AuditLogListResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { AuditPersistenceService } from './audit-persistence.service';

/**
 * The signed-in user's AI-provider audit log (JJ-42): a paginated, newest-first
 * list of every call this instance made to an external AI provider on their
 * behalf. Read-only and strictly self-scoped — the user id comes from the
 * session, never the request.
 */
@Controller({ path: 'audit-log', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditPersistenceService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<AuditLogListResponse> {
    const parsed = auditLogListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return this.audit.list(user.id, parsed.data.page, parsed.data.pageSize);
  }
}
