import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  factListQuerySchema,
  type FactListResponse,
  type ItemFactsResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { InboxService } from '@plaudern/inbox';
import { FactsRegistryService } from './facts-registry.service';
import { FactsService } from './facts.service';

/**
 * The per-user personal-facts read model (JJ-31), optionally scoped to one
 * person entity — the data behind the person dossier (JJ-24). No global ZodError
 * filter exists, so the query is validated with `.safeParse` and surfaced as a
 * 400 rather than a 500 (mirrors the tasks/topics controllers).
 */
@Controller({ path: 'facts', version: '1' })
export class FactsController {
  constructor(private readonly registry: FactsRegistryService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<FactListResponse> {
    const parsed = factListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return { facts: await this.registry.list(user.id, parsed.data) };
  }
}

/**
 * An item's facts read model + manual re-extraction. Mounted on /inbox/:id for
 * symmetry with the tasks/commitments/topics routes; lives in this module so the
 * inbox lib stays free of any facts dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxFactsController {
  constructor(
    private readonly registry: FactsRegistryService,
    private readonly facts: FactsService,
    private readonly inbox: InboxService,
  ) {}

  @Get(':id/facts')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemFactsResponse> {
    const item = await this.inbox.getItem(user.id, id);
    return this.registry.getItemFacts(item);
  }

  @Post(':id/facts/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemFactsResponse> {
    await this.facts.retry(user.id, id);
    const item = await this.inbox.getItem(user.id, id);
    return this.registry.getItemFacts(item);
  }
}
