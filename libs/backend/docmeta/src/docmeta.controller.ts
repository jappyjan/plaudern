import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  documentListQuerySchema,
  type DocumentListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DocMetaService } from './docmeta.service';

/**
 * The user's document vault (JJ-16): every document across all scans, optionally
 * filtered to a single type. The web groups them by type client-side. No global
 * ZodError filter exists, so the query is validated with `.safeParse` and
 * surfaced as a 400 (mirrors the reminders/decisions controllers). The per-item
 * read model + retry live on /inbox/:id in InboxDocMetaController.
 */
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(private readonly docmeta: DocMetaService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<DocumentListResponse> {
    const parsed = documentListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid filter');
    }
    return this.docmeta.list(user.id, parsed.data);
  }
}
