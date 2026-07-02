import { Controller, Param, Post } from '@nestjs/common';
import type { InboxItemDto } from '@plaudern/contracts';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { TranscriptionService } from './transcription.service';

/**
 * Lives in the transcription module (not inbox) so the inbox lib never has to
 * depend on transcription. The route still hangs off /inbox/:id for symmetry
 * with the read API.
 */
@Controller({ path: 'inbox', version: '1' })
export class TranscriptionController {
  constructor(
    private readonly transcription: TranscriptionService,
    private readonly inbox: InboxService,
  ) {}

  @Post(':id/transcription/retry')
  async retry(@Param('id') id: string): Promise<InboxItemDto> {
    await this.transcription.retryTranscription(id);
    const item = await this.inbox.getItem(DEFAULT_USER_ID, id);
    return toInboxItemDto(item);
  }
}
