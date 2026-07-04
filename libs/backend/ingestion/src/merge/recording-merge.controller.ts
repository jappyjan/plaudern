import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import {
  inboxMergeRequestSchema,
  type InboxItemDto,
  type InboxSplitResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { RecordingMergeService } from './recording-merge.service';

/**
 * Merge/split live under the `inbox` path next to the other per-item actions
 * (retry endpoints etc.), but in this module because merging is a form of
 * ingestion: it creates a new item and kicks the pipeline.
 */
@Controller({ path: 'inbox', version: '1' })
export class RecordingMergeController {
  constructor(private readonly merge: RecordingMergeService) {}

  /** Combine several recordings into one new recording (sources are hidden, not deleted). */
  @Post('merge')
  async mergeItems(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<InboxItemDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = inboxMergeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid merge request');
    }
    return this.merge.merge(user.id, parsed.data.itemIds);
  }

  /** Undo a merge: delete the merged recording and restore the originals. */
  @Post(':id/split')
  async split(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxSplitResponse> {
    return this.merge.split(user.id, id);
  }
}
