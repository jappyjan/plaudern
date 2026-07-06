import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  isLocalOnlyTier,
  summaryPayloadSchema,
  type CalendarEventDto,
  type CommitmentDirection,
  type CommitmentDto,
  type CommitmentStatus,
  type DecisionDto,
  type DecisionStatus,
  type EmbeddingChunkSource,
  type EntityDossierDto,
  type EntityRelationEdgeDto,
  type EntityType,
  type JournalCitation,
  type JournalDocumentResponse,
  type JournalPeriodType,
  type PersonalFactDto,
  type QuestionDirection,
  type QuestionDto,
  type QuestionStatus,
  type RegistryEntityDto,
  type ReminderDto,
  type ReminderStatus,
  type RelationType,
  type SourceType,
  type TaskDto,
  type TaskStatus,
  type TopicDto,
  type TopicItemDto,
} from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { InboxService } from '@plaudern/inbox';
import { SearchService } from '@plaudern/search';
import { IngestionService } from '@plaudern/ingestion';
import { SensitivityRoutingService } from '@plaudern/sensitivity';
import { DossierService, EntitiesRegistryService, EntityGraphService } from '@plaudern/entities';
import { FactsRegistryService } from '@plaudern/facts';
import { TasksRegistryService } from '@plaudern/tasks';
import { CommitmentsService } from '@plaudern/commitments';
import { QuestionsService } from '@plaudern/questions';
import { DecisionsService } from '@plaudern/decisions';
import { RemindersService } from '@plaudern/reminders';
import { TopicsService } from '@plaudern/topics';
import { JournalService } from '@plaudern/journal';
import { CalendarEventsService } from '@plaudern/calendar';

/** A single hybrid-search hit as returned to an MCP client. */
export interface SearchMemoryResult {
  itemId: string;
  source: EmbeddingChunkSource;
  /** The matching snippet of transcript or summary. */
  snippet: string;
  /**
   * Fused Reciprocal-Rank-Fusion score; higher is better. NB: rank-based, not
   * cosine similarity — a top hit lands around 0.016-0.033, so absolute
   * thresholds tuned against the old semantic-only cosine scores do not apply.
   */
  score: number;
  /** Segment window (seconds) for transcript hits; null for summary hits. */
  startSeconds: number | null;
  endSeconds: number | null;
}

/** The full detail of one memory item. */
export interface GetItemResult {
  itemId: string;
  sourceType: SourceType;
  occurredAt: string;
  ingestedAt: string;
  title: string | null;
  transcript: string | null;
  summary: { title: string; layout: string; markdown: string } | null;
  /** User-supplied capture metadata (location, tags, source url, …). */
  metadata: Record<string, unknown> | null;
}

/** A compact list entry for recent-items listing. */
export interface RecentItemResult {
  itemId: string;
  sourceType: SourceType;
  occurredAt: string;
  ingestedAt: string;
  title: string | null;
  hasTranscript: boolean;
  hasSummary: boolean;
}

/**
 * The backing logic for the four MCP tools. Deliberately transport-agnostic:
 * these are plain async methods taking the acting `userId` plus already-parsed
 * arguments, so they are unit-testable without an MCP client and are reused by
 * `mcp.server.ts` (which only adapts them to the SDK's tool interface).
 *
 * Every method scopes its work to `userId` — retrieval, item fetch and capture
 * all inherit the token owner's permissions and can never touch another user's
 * memory. Responses carry content only (transcripts, summaries, snippets); they
 * never expose storage keys, tokens or other internal pointers.
 */
@Injectable()
export class McpToolsService {
  constructor(
    private readonly inbox: InboxService,
    private readonly search: SearchService,
    private readonly ingestion: IngestionService,
    // JJ-78: the knowledge-graph read services, each wrapped 1:1, plus the
    // JJ-21 sensitivity gate that every item-derived tool routes through.
    private readonly sensitivity: SensitivityRoutingService,
    private readonly entitiesRegistry: EntitiesRegistryService,
    private readonly entityGraph: EntityGraphService,
    private readonly dossier: DossierService,
    private readonly facts: FactsRegistryService,
    private readonly tasks: TasksRegistryService,
    private readonly commitments: CommitmentsService,
    private readonly questions: QuestionsService,
    private readonly decisions: DecisionsService,
    private readonly reminders: RemindersService,
    private readonly topics: TopicsService,
    private readonly journal: JournalService,
    private readonly calendar: CalendarEventsService,
  ) {}

  /**
   * search_memory: hybrid search (FTS + pgvector + RRF) over the user's memory
   * (JJ-38). Backed by the shared SearchService, so agents get the same fused
   * ranking as the web app and the semantic leg's graceful degradation for
   * free. Response shape is unchanged; `snippet` is stripped of the keyword
   * leg's `<mark>` highlight markers (agents want plain text), and `score` is
   * the fused RRF score.
   */
  async searchMemory(
    userId: string,
    args: { query: string; limit: number },
  ): Promise<SearchMemoryResult[]> {
    const { results } = await this.search.search(userId, {
      query: args.query,
      limit: args.limit,
    });
    return results
      // Local-only routing guard (JJ-21): never surface sensitive/secret item
      // text to an MCP client's (external) model. FAIL CLOSED — a not-yet-
      // classified item (null tier) is FTS-searchable before the sentinel runs,
      // so an unknown tier is excluded, not surfaced.
      .filter((r) => !!r.sensitivityTier && !isLocalOnlyTier(r.sensitivityTier))
      .map((r) => ({
        itemId: r.itemId,
        source: r.snippetSource ?? 'summary',
        snippet: stripHighlights(r.snippet ?? ''),
        score: r.fusedScore,
        startSeconds: r.startSeconds,
        endSeconds: r.endSeconds,
      }));
  }

  /** get_item: full transcript, summary and metadata for one item. */
  async getItem(userId: string, args: { itemId: string }): Promise<GetItemResult> {
    const item = await this.inbox.getItem(userId, args.itemId);
    const transcription = latestSucceeded(item, 'transcription');
    const summary = parseSummary(latestSucceeded(item, 'summary'));
    return {
      itemId: item.id,
      sourceType: item.sourceType,
      occurredAt: toIso(item.occurredAt),
      ingestedAt: toIso(item.ingestedAt),
      title: titleOf(item, summary),
      transcript: transcription?.content ?? null,
      summary: summary
        ? { title: summary.title, layout: summary.layout, markdown: summary.markdown }
        : null,
      metadata: item.metadata ?? null,
    };
  }

  /** list_recent_items: newest-first page of the user's memory. */
  async listRecentItems(
    userId: string,
    args: { limit: number; cursor?: string },
  ): Promise<{ items: RecentItemResult[]; nextCursor: string | null }> {
    const { items, nextCursor } = await this.inbox.listItems(userId, args.limit, args.cursor);
    return {
      items: items.map((item) => {
        const summary = parseSummary(latestSucceeded(item, 'summary'));
        return {
          itemId: item.id,
          sourceType: item.sourceType,
          occurredAt: toIso(item.occurredAt),
          ingestedAt: toIso(item.ingestedAt),
          title: titleOf(item, summary),
          hasTranscript: Boolean(latestSucceeded(item, 'transcription')?.content),
          hasSummary: Boolean(summary),
        };
      }),
      nextCursor,
    };
  }

  /**
   * ingest_text_note: capture a plain-text note into the inbox (same path the
   * web app uses). `occurredAt` defaults to now and `idempotencyKey` to a fresh
   * UUID, so repeat calls create distinct notes unless the caller pins a key.
   */
  async ingestTextNote(
    userId: string,
    args: { text: string; occurredAt?: string; idempotencyKey?: string },
  ): Promise<{ itemId: string }> {
    const item = await this.ingestion.ingestText(userId, {
      text: args.text,
      occurredAt: args.occurredAt ?? new Date().toISOString(),
      idempotencyKey: args.idempotencyKey ?? `mcp-note-${randomUUID()}`,
    });
    return { itemId: item.id };
  }

  // ---- JJ-78 knowledge-graph read tools ----
  //
  // Every method below is user-scoped (the closed-over token owner) and routes
  // any item-derived content through the JJ-21 sensitivity gate: sensitive/
  // secret items and NOT-YET-CLASSIFIED (null-tier) items are excluded, FAIL
  // CLOSED, exactly like search_memory. See `allowedItemIds`/`visibleEntityIds`.

  /**
   * list_entities: the entity registry (people/orgs/places/…), newest activity
   * first. Gated so an entity backed ONLY by sensitive/secret/unclassified items
   * never appears. Optional `type` filter and case-insensitive name/alias
   * `query` substring; cursor-paginated.
   */
  async listEntities(
    userId: string,
    args: { type?: EntityType; query?: string; limit: number; cursor?: string },
  ): Promise<{ entities: EntityListEntry[]; nextCursor: string | null }> {
    const all = await this.entitiesRegistry.list(userId, args.type);
    const q = args.query?.trim().toLowerCase();
    const matched = q
      ? all.filter(
          (e) =>
            e.canonicalName.toLowerCase().includes(q) ||
            e.aliases.some((a) => a.toLowerCase().includes(q)),
        )
      : all;
    const visible = await this.visibleEntityIds(
      userId,
      matched.map((e) => e.id),
    );
    const gated = matched.filter((e) => visible.has(e.id));
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { entities: page.map(toEntityListEntry), nextCursor };
  }

  /**
   * get_entity: the full person/entity dossier — identity, personal facts,
   * commitments both ways, open questions, knowledge-graph relations and recent
   * mentions, each cited to a source item. Every item-derived element is passed
   * through the sensitivity gate: sensitive/unclassified citations, commitments,
   * questions and mentions are dropped, and relations to entities that are not
   * themselves externally visible are removed; counts are recomputed from what
   * survives. If the entity has no externally-visible source at all it 404s, so
   * its very existence is never confirmed over this surface.
   */
  async getEntity(userId: string, args: { entityId: string }): Promise<EntityDossierDto> {
    const visible = await this.visibleEntityIds(userId, [args.entityId]);
    if (!visible.has(args.entityId)) throw new NotFoundException('entity not found');
    const dossier = await this.dossier.build(userId, args.entityId);
    return this.redactDossier(userId, dossier);
  }

  /**
   * list_relations: the asserted (non-co-occurrence) knowledge-graph edges
   * touching one entity, plus the connected neighbors' names. The aggregated
   * edge read model exposes no per-evidence item id, so edges are gated by
   * ENDPOINT VISIBILITY — an edge shows only when both its entities are
   * independently visible in non-sensitive content (fail-closed proxy). Optional
   * `relationType` filter; cursor-paginated.
   */
  async listRelations(
    userId: string,
    args: { entityId: string; relationType?: RelationType; limit: number; cursor?: string },
  ): Promise<{
    relations: EntityRelationEdgeDto[];
    neighbors: NeighborEntry[];
    nextCursor: string | null;
  }> {
    const visible = await this.visibleEntityIds(userId, [args.entityId]);
    if (!visible.has(args.entityId)) throw new NotFoundException('entity not found');
    const edges = await this.entityGraph.edgesFor(userId, args.entityId, args.relationType, false);
    const neighborIds = [
      ...new Set(edges.flatMap((e) => [e.sourceEntityId, e.targetEntityId])),
    ].filter((id) => id !== args.entityId);
    const visibleNeighbors = await this.visibleEntityIds(userId, neighborIds);
    const gated = edges.filter((e) => {
      const other = e.sourceEntityId === args.entityId ? e.targetEntityId : e.sourceEntityId;
      return visibleNeighbors.has(other);
    });
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    const pageNeighborIds = [
      ...new Set(page.flatMap((e) => [e.sourceEntityId, e.targetEntityId])),
    ].filter((id) => id !== args.entityId);
    return { relations: page, neighbors: await this.neighborEntries(userId, pageNeighborIds), nextCursor };
  }

  /**
   * list_facts: durable personal facts about people (attribute/value pairs).
   * Gated so a fact whose every citation is sensitive/unclassified is dropped.
   * Optional `personEntityId` scope; `includeSuperseded` off by default;
   * cursor-paginated.
   */
  async listFacts(
    userId: string,
    args: {
      personEntityId?: string;
      includeSuperseded?: boolean;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ facts: FactListEntry[]; nextCursor: string | null }> {
    const { facts, citationRefs } = await this.facts.listWithCitations(userId, {
      personEntityId: args.personEntityId,
      includeSuperseded: args.includeSuperseded ?? false,
    });
    const allowed = await this.allowedItemIds(
      [...citationRefs.values()].flatMap((refs) => refs.map((r) => r.inboxItemId)),
    );
    const gated = facts.filter((f) =>
      (citationRefs.get(f.id) ?? []).some((r) => allowed.has(r.inboxItemId)),
    );
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { facts: page.map(toFactListEntry), nextCursor };
  }

  /**
   * list_tasks: the extracted to-do list. A task is deduped across many
   * recordings, so it is gated by its citations' source items: a task survives
   * only when at least one citing item is externally visible. Optional `status`;
   * cursor-paginated.
   */
  async listTasks(
    userId: string,
    args: { status?: TaskStatus; limit: number; cursor?: string },
  ): Promise<{ tasks: TaskDto[]; nextCursor: string | null }> {
    const all = await this.tasks.list(userId, args.status);
    const citations = await this.tasks.citationItemIds(
      userId,
      all.map((t) => t.id),
    );
    const allowed = await this.allowedItemIds([...citations.values()].flat());
    const gated = all.filter((t) => (citations.get(t.id) ?? []).some((i) => allowed.has(i)));
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { tasks: page, nextCursor };
  }

  /** list_commitments: promises owed by/to the user, gated by source item. */
  async listCommitments(
    userId: string,
    args: {
      direction?: CommitmentDirection;
      status?: CommitmentStatus;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ commitments: CommitmentDto[]; nextCursor: string | null }> {
    const { commitments } = await this.commitments.list(userId, {
      direction: args.direction,
      status: args.status,
    });
    const gated = await this.filterByInboxItem(commitments);
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { commitments: page, nextCursor };
  }

  /** list_questions: open/answered questions either way, gated by source item. */
  async listQuestions(
    userId: string,
    args: {
      direction?: QuestionDirection;
      status?: QuestionStatus;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ questions: QuestionDto[]; nextCursor: string | null }> {
    const { questions } = await this.questions.list(userId, {
      direction: args.direction,
      status: args.status,
    });
    const gated = await this.filterByInboxItem(questions);
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { questions: page, nextCursor };
  }

  /** list_decisions: recorded decisions, gated by source item. */
  async listDecisions(
    userId: string,
    args: {
      status?: DecisionStatus;
      participantEntityId?: string;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ decisions: DecisionDto[]; nextCursor: string | null }> {
    const { decisions } = await this.decisions.list(userId, {
      status: args.status,
      participantEntityId: args.participantEntityId,
    });
    const gated = await this.filterByInboxItem(decisions);
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { decisions: page, nextCursor };
  }

  /** list_reminders: time-based reminders (optional due-window), gated by source item. */
  async listReminders(
    userId: string,
    args: {
      status?: ReminderStatus;
      from?: string;
      to?: string;
      limit: number;
      cursor?: string;
    },
  ): Promise<{ reminders: ReminderDto[]; nextCursor: string | null }> {
    const { reminders } = await this.reminders.list(userId, {
      status: args.status,
      from: args.from,
      to: args.to,
    });
    const gated = await this.filterByInboxItem(reminders);
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { reminders: page, nextCursor };
  }

  /**
   * list_topics: the topic taxonomy. Gated to topics with at least one
   * externally-visible assigned item (a topic that exists only because of a
   * sensitive/unclassified recording is withheld); `itemCount` counts visible
   * assignments only.
   */
  async listTopics(userId: string): Promise<{ topics: TopicListEntry[] }> {
    const topics = await this.topics.listTopics(userId);
    if (topics.length === 0) return { topics: [] };
    const assignments = await Promise.all(
      topics.map((t) => this.topics.listItemsByTopic(userId, t.id)),
    );
    const allowed = await this.allowedItemIds(
      assignments.flatMap((a) => a.items.map((i) => i.inboxItemId)),
    );
    const entries = topics
      .map((t, i) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        archived: t.archived,
        itemCount: assignments[i].items.filter((it) => allowed.has(it.inboxItemId)).length,
      }))
      .filter((t) => t.itemCount > 0);
    return { topics: entries };
  }

  /**
   * get_topic: the items assigned to one topic (the item↔topic read model),
   * gated by source item. Cursor-paginated.
   */
  async getTopic(
    userId: string,
    args: { topicId: string; limit: number; cursor?: string },
  ): Promise<{ topicId: string; items: TopicItemDto[]; nextCursor: string | null }> {
    const assigned = await this.topics.listItemsByTopic(userId, args.topicId);
    const allowed = await this.allowedItemIds(assigned.items.map((i) => i.inboxItemId));
    const gated = assigned.items.filter((i) => allowed.has(i.inboxItemId));
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { topicId: args.topicId, items: page, nextCursor };
  }

  /**
   * list_journal_periods: which day/week/month/year rollups exist. Metadata
   * only — the item-derived preview text is deliberately NOT returned here; use
   * get_journal for the gated narrative body.
   */
  async listJournalPeriods(
    userId: string,
    args: { periodType: JournalPeriodType },
  ): Promise<{ periods: JournalPeriodEntry[] }> {
    const { periods } = await this.journal.listPeriods(userId, args.periodType);
    return {
      periods: periods.map((p) => ({
        periodType: p.periodType,
        periodKey: p.periodKey,
        version: p.version,
        sourceItemCount: p.sourceItemCount,
        generatedAt: p.generatedAt,
      })),
    };
  }

  /**
   * get_journal: one rollup's composed narrative for a period. If ANY direct
   * source-item citation is sensitive/unclassified the markdown body is withheld
   * (`markdown` null, `redacted` true) and that citation is dropped, since the
   * synthesized text could quote it. NB: weekly/monthly/yearly rollups also cite
   * child day entries (`kind: 'journal'`) transitively — only DIRECT item
   * citations are gated here; deeper transitive gating is a follow-up.
   */
  async getJournal(
    userId: string,
    args: { periodType: JournalPeriodType; periodKey: string },
  ): Promise<JournalDocumentResponse & { redacted: boolean }> {
    const doc = await this.journal.getJournal(userId, args.periodType, args.periodKey);
    const itemRefs = doc.citations
      .filter((c: JournalCitation) => c.kind === 'item')
      .map((c) => c.refId);
    const allowed = await this.allowedItemIds(itemRefs);
    if (itemRefs.every((r) => allowed.has(r))) return { ...doc, redacted: false };
    return {
      ...doc,
      markdown: null,
      citations: doc.citations.filter((c) => !(c.kind === 'item' && !allowed.has(c.refId))),
      redacted: true,
    };
  }

  /**
   * list_calendar_events: events overlapping [from, to]. An event's own text
   * comes from the external calendar feed (not from inbox items), so events are
   * returned as-is; only their `linkedRecordingIds` are filtered to
   * externally-visible items, so a sensitive recording is never revealed as
   * linked to a time/place.
   */
  async listCalendarEvents(
    userId: string,
    args: { from: string; to: string },
  ): Promise<{ events: CalendarEventDto[] }> {
    const events = await this.calendar.eventsInRange(userId, args.from, args.to);
    const allowed = await this.allowedItemIds(events.flatMap((e) => e.linkedRecordingIds));
    return {
      events: events.map((e) => ({
        ...e,
        linkedRecordingIds: e.linkedRecordingIds.filter((id) => allowed.has(id)),
      })),
    };
  }

  // ---- sensitivity gating (JJ-21 fail-closed, shared by every tool above) ----

  /**
   * The subset of `itemIds` that may cross this EXTERNAL MCP surface: an item
   * whose effective sensitivity tier is KNOWN and not local-only (public/normal).
   * FAIL CLOSED — a null/unknown tier (item not yet classified by the sentinel,
   * or with no sensitivity row at all) is excluded, mirroring search_memory.
   */
  private async allowedItemIds(itemIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(itemIds)].filter(Boolean);
    const allowed = new Set<string>();
    if (unique.length === 0) return allowed;
    const tiers = await this.sensitivity.effectiveTiers(unique);
    for (const id of unique) {
      const tier = tiers.get(id);
      if (tier && !isLocalOnlyTier(tier)) allowed.add(id);
    }
    return allowed;
  }

  /**
   * Registry entity ids that are externally VISIBLE: those with at least one
   * mention in an externally-allowed item. An entity mentioned only in
   * sensitive/secret/unclassified items is not visible, so it never appears in
   * list_entities, is never a shown relation endpoint, and get_entity 404s for it.
   */
  private async visibleEntityIds(userId: string, entityIds: string[]): Promise<Set<string>> {
    const visible = new Set<string>();
    if (entityIds.length === 0) return visible;
    const mentions = await this.entitiesRegistry.mentionItemIds(userId, entityIds);
    const allowed = await this.allowedItemIds([...mentions.values()].flat());
    for (const [entityId, items] of mentions) {
      if (items.some((i) => allowed.has(i))) visible.add(entityId);
    }
    return visible;
  }

  /** Filter single-source rows (one `inboxItemId` each) to their allowed items. */
  private async filterByInboxItem<T extends { inboxItemId: string }>(rows: T[]): Promise<T[]> {
    const allowed = await this.allowedItemIds(rows.map((r) => r.inboxItemId));
    return rows.filter((r) => allowed.has(r.inboxItemId));
  }

  /** Resolve visible neighbor ids to their names/types for a relations page. */
  private async neighborEntries(userId: string, ids: string[]): Promise<NeighborEntry[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const all = await this.entitiesRegistry.list(userId, undefined, true);
    return all
      .filter((e) => wanted.has(e.id))
      .map((e) => ({ id: e.id, canonicalName: e.canonicalName, type: e.type }));
  }

  /** Strip every sensitive/unclassified element from a dossier (see get_entity). */
  private async redactDossier(
    userId: string,
    dossier: EntityDossierDto,
  ): Promise<EntityDossierDto> {
    const itemIds: string[] = [];
    for (const f of [...dossier.facts.active, ...dossier.facts.superseded]) {
      for (const c of f.citations) itemIds.push(c.inboxItemId);
    }
    for (const c of [...dossier.commitments.owedByMe, ...dossier.commitments.owedToMe]) {
      itemIds.push(c.inboxItemId);
    }
    for (const q of dossier.openQuestions) itemIds.push(q.inboxItemId);
    for (const r of dossier.recentItems) itemIds.push(r.inboxItemId);
    const allowed = await this.allowedItemIds(itemIds);

    const gateFact = <T extends { citations: { inboxItemId: string }[] }>(fact: T): T | null => {
      const citations = fact.citations.filter((c) => allowed.has(c.inboxItemId));
      return citations.length > 0 ? { ...fact, citations } : null;
    };
    const activeFacts = dossier.facts.active.map(gateFact).filter(nonNull);
    const supersededFacts = dossier.facts.superseded.map(gateFact).filter(nonNull);
    const owedByMe = dossier.commitments.owedByMe.filter((c) => allowed.has(c.inboxItemId));
    const owedToMe = dossier.commitments.owedToMe.filter((c) => allowed.has(c.inboxItemId));
    const openQuestions = dossier.openQuestions.filter((q) => allowed.has(q.inboxItemId));
    const recentItems = dossier.recentItems.filter((r) => allowed.has(r.inboxItemId));

    // Relations: keep only edges whose OTHER endpoint is itself visible.
    const visibleNeighbors = await this.visibleEntityIds(
      userId,
      dossier.neighbors.map((n) => n.id),
    );
    const relations = dossier.relations.filter((e) => {
      const other =
        e.sourceEntityId === dossier.entity.id ? e.targetEntityId : e.sourceEntityId;
      return other === dossier.entity.id || visibleNeighbors.has(other);
    });
    const keptNeighbors = new Set(
      relations
        .flatMap((e) => [e.sourceEntityId, e.targetEntityId])
        .filter((id) => id !== dossier.entity.id),
    );
    const neighbors = dossier.neighbors.filter((n) => keptNeighbors.has(n.id));

    return {
      ...dossier,
      facts: { active: activeFacts, superseded: supersededFacts },
      commitments: { owedByMe, owedToMe },
      openQuestions,
      relations,
      neighbors,
      recentItems,
      counts: {
        activeFacts: activeFacts.length,
        supersededFacts: supersededFacts.length,
        owedByMe: owedByMe.length,
        owedToMe: owedToMe.length,
        openQuestions: openQuestions.length,
        relations: relations.length,
        mentions: recentItems.length,
      },
    };
  }
}

/** A compact entity-registry entry for list_entities (full view is get_entity). */
export interface EntityListEntry {
  id: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  mentionCount: number;
  /** Linked contact-book name, when this entity is a known contact. */
  contactName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

function toEntityListEntry(e: RegistryEntityDto): EntityListEntry {
  return {
    id: e.id,
    type: e.type,
    canonicalName: e.canonicalName,
    aliases: e.aliases,
    mentionCount: e.mentionCount,
    contactName: e.voiceProfileName,
    firstSeenAt: e.firstSeenAt,
    lastSeenAt: e.lastSeenAt,
  };
}

/** A compact personal-fact entry for list_facts. */
export interface FactListEntry {
  id: string;
  personEntityId: string | null;
  personName: string;
  attribute: string;
  value: string;
  active: boolean;
  exclusive: boolean;
  citationCount: number;
  lastSeenAt: string;
}

function toFactListEntry(f: PersonalFactDto): FactListEntry {
  return {
    id: f.id,
    personEntityId: f.personEntityId,
    personName: f.personName,
    attribute: f.attribute,
    value: f.value,
    active: f.active,
    exclusive: f.exclusive,
    citationCount: f.citationCount,
    lastSeenAt: f.lastSeenAt,
  };
}

/** A connected entity's identity, returned alongside list_relations edges. */
export interface NeighborEntry {
  id: string;
  canonicalName: string;
  type: EntityType;
}

/** A compact taxonomy entry for list_topics, with the visible-assignment count. */
export interface TopicListEntry {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  itemCount: number;
}

/** A journal period's existence/metadata for list_journal_periods (no body). */
export interface JournalPeriodEntry {
  periodType: JournalPeriodType;
  periodKey: string;
  version: number | null;
  sourceItemCount: number | null;
  generatedAt: string | null;
}

/** Narrowing predicate for `.filter()` that also strips the `null` from the type. */
function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Offset pagination over an already-materialized, already-gated list. The cursor
 * is the numeric start offset as a string (opaque to callers); because gating
 * happens BEFORE the slice, pages are full up to `limit` except the last, and
 * `nextCursor` is null on the last page.
 */
function paginate<T>(
  items: T[],
  limit: number,
  cursor?: string,
): { page: T[]; nextCursor: string | null } {
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const page = items.slice(start, start + limit);
  const nextStart = start + limit;
  return { page, nextCursor: nextStart < items.length ? String(nextStart) : null };
}

/** Remove the keyword leg's `<mark>` highlight markers for plain-text agents. */
function stripHighlights(text: string): string {
  return text.replace(/<\/?mark>/g, '');
}

function latestSucceeded(
  item: InboxItemEntity,
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return (item.extractions ?? [])
    .filter((e) => e.kind === kind && e.status === 'succeeded')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function parseSummary(
  extraction: ExtractedPayloadEntity | undefined,
): { title: string; layout: string; markdown: string } | null {
  if (!extraction?.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(extraction.content));
    if (!parsed.success) return null;
    return {
      title: parsed.data.title,
      layout: parsed.data.layout,
      markdown: parsed.data.markdown,
    };
  } catch {
    return null;
  }
}

function titleOf(
  item: InboxItemEntity,
  summary: { title: string } | null,
): string | null {
  const tags = (item.metadata?.tags as Record<string, unknown> | undefined) ?? undefined;
  const tagTitle = typeof tags?.title === 'string' ? tags.title : null;
  return tagTitle ?? summary?.title ?? null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
