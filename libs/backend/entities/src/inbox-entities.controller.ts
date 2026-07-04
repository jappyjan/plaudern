import { Controller, Param, Post } from '@nestjs/common';
import type { InboxItemDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { EntitiesService } from './entities.service';
import { RelationsService } from './relations.service';

/**
 * Per-item retries for the entity and relation extraction steps. Lives in the
 * entities module (not inbox) so the inbox lib never has to depend on entities;
 * the routes hang off /inbox/:id for symmetry with the transcription,
 * diarization and topics retries.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxEntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly relations: RelationsService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Re-run entity extraction for an item; returns the refreshed item. Relations
   * re-run automatically once entities succeed — the DAG re-evaluates every
   * dependent step when an extraction settles.
   */
  @Post(':id/entities/retry')
  async retryEntities(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    await this.entities.retry(user.id, id);
    return toInboxItemDto(await this.inbox.getItem(user.id, id));
  }

  /**
   * Re-run relation extraction only (relations-only; the entities extraction it
   * depends on is not re-run). Guarded server-side on a succeeded entities
   * extraction existing.
   */
  @Post(':id/relations/retry')
  async retryRelations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    await this.relations.retry(user.id, id);
    return toInboxItemDto(await this.inbox.getItem(user.id, id));
  }
}
