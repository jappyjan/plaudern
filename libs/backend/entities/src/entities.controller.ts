import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  entityConnectQuerySchema,
  entityListQuerySchema,
  entityNeighborhoodQuerySchema,
  mergeEntityRequestSchema,
  relinkEntityContactRequestSchema,
  updateEntityRequestSchema,
  type EntityConnectResponse,
  type EntityDetailWithRelationsDto,
  type EntityListResponse,
  type EntityNeighborhoodResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesCorrectionService } from './entities-correction.service';
import { EntityGraphService } from './entity-graph.service';

/**
 * Read model over the per-user entity registry and knowledge graph (JJ-32 /
 * JJ-22): list entities, fetch one entity with its mentions and edges, walk an
 * entity's neighborhood, and find the subgraph connecting 2–3 entities. Also
 * the merge & correction mutations (JJ-63): merge, rename/retype, re-link a
 * contact, and delete/suppress — each returns the refreshed detail read model.
 */
@Controller({ path: 'entities', version: '1' })
export class EntitiesController {
  constructor(
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
    private readonly corrections: EntitiesCorrectionService,
  ) {}

  /** The detail read model (mentions + edges) for one entity — the mutation reply. */
  private async detailWithRelations(
    userId: string,
    id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    const detail = await this.registry.detail(userId, id);
    return { ...detail, relations: await this.graph.edgesFor(userId, id) };
  }

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
    return this.graph.connect(
      user.id,
      parsed.data.ids,
      parsed.data.maxDepth,
      parsed.data.includeCooccurrence,
    );
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    return this.detailWithRelations(user.id, id);
  }

  /**
   * Merge another entity (the victim) into this one (the survivor). Unions
   * aliases/mentions/relations and records the victim's names as aliases so
   * re-extraction resolves to the survivor. Returns the survivor's detail.
   */
  @Post(':id/merge')
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = mergeEntityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const survivorId = await this.corrections.merge(user.id, id, parsed.data.victimId);
    return this.detailWithRelations(user.id, survivorId);
  }

  /** Rename and/or retype an entity (correct a wrong extraction). */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = updateEntityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid body');
    }
    await this.corrections.update(user.id, id, parsed.data);
    return this.detailWithRelations(user.id, id);
  }

  /** Re-link (or unlink, with null) a person entity to a voice-profile contact. */
  @Patch(':id/contact')
  async relinkContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = relinkEntityContactRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid body');
    }
    await this.corrections.relinkContact(user.id, id, parsed.data.voiceProfileId);
    return this.detailWithRelations(user.id, id);
  }

  /** Delete/suppress an entity so re-extraction cannot recreate it. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.corrections.suppress(user.id, id);
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
