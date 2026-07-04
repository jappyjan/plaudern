import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import {
  ingestInitRequestSchema,
  ingestTextRequestSchema,
  ingestWebRequestSchema,
  type IngestInitResponse,
  type IngestTextRequest,
  type IngestWebRequest,
  type InboxItemDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { IngestionService } from './ingestion.service';

/**
 * Generic ingestion endpoints. `init`/`commit` drive the presigned upload for
 * any blob source (audio/file/plaud); `text` is the inline path. The concrete
 * behaviour per source lives in the adapters (plan §2).
 */
@Controller({ path: 'ingest', version: '1' })
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('init')
  async init(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<IngestInitResponse> {
    const req = ingestInitRequestSchema.parse(body);
    return this.ingestion.init(user.id, req);
  }

  @Post(':id/commit')
  async commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    return this.ingestion.commit(user.id, id);
  }

  @Post(':id/reprocess')
  async reprocess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    return this.ingestion.reprocess(user.id, id);
  }

  @Post('text')
  async text(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<InboxItemDto> {
    const req: IngestTextRequest = ingestTextRequestSchema.parse(body);
    return this.ingestion.ingestText(user.id, req);
  }

  /** Web clip / share-target ingestion (`sources/web`) — inline like text. */
  @Post('web')
  async web(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<InboxItemDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = ingestWebRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid web clip request');
    }
    const req: IngestWebRequest = parsed.data;
    return this.ingestion.ingestWeb(user.id, req);
  }
}
