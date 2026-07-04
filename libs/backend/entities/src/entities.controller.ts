import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  entityListQuerySchema,
  type EntityDetailDto,
  type EntityListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { EntitiesRegistryService } from './entities-registry.service';

/**
 * Read model over the per-user entity registry (JJ-32): list entities
 * (optionally filtered by type) and fetch one entity with its mentions.
 */
@Controller({ path: 'entities', version: '1' })
export class EntitiesController {
  constructor(private readonly registry: EntitiesRegistryService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<EntityListResponse> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = entityListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return { entities: await this.registry.list(user.id, parsed.data.type) };
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailDto> {
    return this.registry.detail(user.id, id);
  }
}
