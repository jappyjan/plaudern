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
  Put,
  Query,
} from '@nestjs/common';
import {
  duplicateCandidatesQuerySchema,
  entityConnectQuerySchema,
  entityListQuerySchema,
  entityNeighborhoodQuerySchema,
  linkEntityContactRequestSchema,
  mergeEntityRequestSchema,
  mergeSuggestionsQuerySchema,
  reconcileRequestSchema,
  updateEntityRequestSchema,
  type AutoLinkEntitiesResponse,
  type DuplicateCandidatesResponse,
  type EntityConnectResponse,
  type EntityContactSuggestionsResponse,
  type EntityDetailWithRelationsDto,
  type EntityListResponse,
  type EntityNeighborhoodResponse,
  type MergeSuggestionsResponse,
  type ReconcileResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesCorrectionService } from './entities-correction.service';
import { EntityReconciliationService } from './entity-reconciliation.service';
import { EntityContactResolverService } from './entity-contact-resolver.service';
import { EntityGraphService } from './entity-graph.service';

/**
 * The per-user entity registry and knowledge graph (JJ-32 / JJ-22 / JJ-63):
 * list entities, fetch one entity with its mentions and edges, walk an
 * entity's neighborhood, find the subgraph connecting 2–3 entities — plus
 * correction tooling: merge two entities, edit name/type, delete/suppress,
 * link/unlink a person entity to a contact-book voice profile, convert one
 * into a new contact, and sweep auto-linking over everything still unlinked.
 */
@Controller({ path: 'entities', version: '1' })
export class EntitiesController {
  constructor(
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
    private readonly resolver: EntityContactResolverService,
    private readonly corrections: EntitiesCorrectionService,
    private readonly reconciliation: EntityReconciliationService,
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
    return this.graph.connect(
      user.id,
      parsed.data.ids,
      parsed.data.maxDepth,
      parsed.data.includeCooccurrence,
    );
  }

  /**
   * Re-run intelligent contact resolution over every unlinked person entity —
   * used after naming a speaker in the contact book so mentions of them link
   * up too. Evidence-based (names, voices, knowledge graph), LLM-assisted
   * when a resolution provider is configured.
   */
  @Post('auto-link')
  async autoLink(@CurrentUser() user: AuthenticatedUser): Promise<AutoLinkEntitiesResponse> {
    return { linked: await this.resolver.autoLinkAll(user.id) };
  }

  /**
   * Recorded merge suggestions (default: pending) — likely-duplicate pairs
   * detected automatically after extraction. Declared before `:id` so the
   * static path is not shadowed by the id route.
   */
  @Get('suggestions')
  async suggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<MergeSuggestionsResponse> {
    const parsed = mergeSuggestionsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return { suggestions: await this.reconciliation.listSuggestions(user.id, parsed.data.status) };
  }

  /** Dismiss a merge suggestion so it is not surfaced again. */
  @Post('suggestions/:sid/dismiss')
  @HttpCode(204)
  async dismissSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sid') sid: string,
  ): Promise<void> {
    await this.reconciliation.dismiss(user.id, sid);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    return this.detailWithRelations(user.id, id);
  }

  /** Ranked, evidence-explained contact candidates for a person entity. */
  @Get(':id/contact-suggestions')
  async contactSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityContactSuggestionsResponse> {
    return { suggestions: await this.resolver.suggest(user.id, id) };
  }

  /**
   * Likely-duplicate entities for this one: another entity with the same name
   * under a different type (the split-typed case), plus — when `fuzzy=true` —
   * similar names worth confirming. Read-only; the user merges through the
   * existing merge endpoint.
   */
  @Get(':id/duplicate-candidates')
  async duplicateCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<DuplicateCandidatesResponse> {
    const parsed = duplicateCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    return {
      candidates: await this.reconciliation.findCandidates(user.id, id, {
        fuzzy: parsed.data.fuzzy,
      }),
    };
  }

  /**
   * Ask the LLM judge whether this entity and `candidateId` are the same
   * real-world thing (and which type/survivor to keep). Advisory only — apply
   * via the merge endpoint. `recommendation` is null when no judge is
   * configured, so the client can degrade.
   */
  @Post(':id/reconcile')
  async reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReconcileResponse> {
    const parsed = reconcileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    return {
      recommendation: await this.reconciliation.recommend(user.id, id, parsed.data.candidateId, {
        web: parsed.data.web,
      }),
    };
  }

  /**
   * Merge another entity (the victim) into this one (the survivor). Unions
   * aliases/mentions/relations and records the victim's names as durable
   * aliases so re-extraction resolves to the survivor. Returns the survivor.
   */
  @Post(':id/merge')
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = mergeEntityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    const survivorId = await this.corrections.merge(user.id, id, parsed.data.victimId);
    return this.detailWithRelations(user.id, survivorId);
  }

  /**
   * Correct an entity: rename it and/or change its type (JJ-63). Durable
   * against re-extraction: the old identity is recorded in `entity_aliases`
   * so the pre-correction name folds back in instead of being recreated.
   */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = updateEntityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    await this.corrections.update(user.id, id, parsed.data);
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

  /** Manually link a person entity to a contact-book voice profile. */
  @Put(':id/contact-link')
  async linkContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EntityDetailWithRelationsDto> {
    const parsed = linkEntityContactRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    await this.registry.linkContact(user.id, id, parsed.data.voiceProfileId);
    return this.detailWithRelations(user.id, id);
  }

  /** Unlink from the contact book and stop auto-linking from re-linking. */
  @Delete(':id/contact-link')
  async unlinkContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    await this.registry.unlinkContact(user.id, id);
    return this.detailWithRelations(user.id, id);
  }

  /** Promote a person entity to a new confirmed contact and link it. */
  @Post(':id/convert-to-contact')
  async convertToContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    await this.registry.convertToContact(user.id, id);
    return this.detailWithRelations(user.id, id);
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

  /**
   * Detail + graph edges — the shape every mutation returns for UI refresh.
   * The detail page's Relations list shows only edges the model actually
   * asserted; weak same-recording co-occurrence edges are excluded so the list
   * carries signal, not every pair that happened to be mentioned together.
   */
  private async detailWithRelations(
    userId: string,
    id: string,
  ): Promise<EntityDetailWithRelationsDto> {
    const detail = await this.registry.detail(userId, id);
    return {
      ...detail,
      relations: await this.graph.edgesFor(userId, id, undefined, false),
    };
  }
}
