import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  entityConnectQuerySchema,
  entityListQuerySchema,
  entityNeighborhoodQuerySchema,
  type EntityConnectResponse,
  type EntityDetailWithRelationsDto,
  type EntityListResponse,
  type EntityNeighborhoodResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityGraphService } from './entity-graph.service';

/**
 * Read model over the per-user entity registry and knowledge graph (JJ-32 /
 * JJ-22): list entities, fetch one entity with its mentions and edges, walk an
 * entity's neighborhood, and find the subgraph connecting 2–3 entities.
 */
@Controller({ path: 'entities', version: '1' })
export class EntitiesController {
  constructor(
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
  ) {}

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
    return {
      entities: await this.registry.list(
        user.id,
        parsed.data.type,
        parsed.data.includeUnreferenced,
      ),
    };
  }

  /** The subgraph connecting 2–3 entities (bounded shortest paths). */
  @Get('graph/connect')
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<EntityConnectResponse> {
    const parsed = entityConnectQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return this.graph.connect(user.id, parsed.data.ids, parsed.data.maxDepth);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    const detail = await this.registry.detail(user.id, id);
    return { ...detail, relations: await this.graph.edgesFor(user.id, id) };
  }

  /** One hop around an entity: edges + connected entities, filterable by type. */
  @Get(':id/neighborhood')
  neighborhood(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<EntityNeighborhoodResponse> {
    const parsed = entityNeighborhoodQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return this.graph.neighborhood(user.id, id, parsed.data.relationType);
  }
}
