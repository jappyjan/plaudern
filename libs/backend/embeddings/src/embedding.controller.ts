import { Controller, Param, Post } from '@nestjs/common';
import type { InboxItemDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { EmbeddingService } from './embedding.service';

/**
 * Lives in the embeddings module (not inbox) so the inbox lib never has to
 * depend on embeddings. The route still hangs off /inbox/:id for symmetry with
 * the transcription and diarization retries.
 */
@Controller({ path: 'inbox', version: '1' })
export class EmbeddingController {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly inbox: InboxService,
  ) {}

  /** Re-generate embeddings for an item; returns the refreshed item. */
  @Post(':id/embeddings/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    await this.embeddings.retry(user.id, id);
    return toInboxItemDto(await this.inbox.getItem(user.id, id));
  }
}
