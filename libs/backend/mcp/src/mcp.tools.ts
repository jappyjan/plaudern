import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
import { analyzeCitationCoverage } from '@plaudern/citations';
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
import { JournalService, childTypeOf } from '@plaudern/journal';
import { CalendarEventsService } from '@plaudern/calendar';
import { AiAuditRecorder } from '@plaudern/audit';

/**
 * The authenticated actor behind an MCP call: the token OWNER (every tool scopes
 * to `userId`) plus the acting token's non-secret display prefix, which the
 * mutation tools record in the audit trail so a user can see WHICH token changed
 * what. Read tools only need `userId`.
 */
export interface McpActor {
  userId: string;
  tokenPrefix: string;
}

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
  /**
   * True when the item's effective sensitivity tier is local-only (sensitive/
   * secret) or not yet classified: its content is WITHHELD from this external
   * surface (JJ-86), so `transcript`/`summary`/`metadata`/`title` are null.
   */
  redacted: boolean;
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
    // JJ-78 follow-up: records every MCP MUTATION into the shared audit trail.
    private readonly audit: AiAuditRecorder,
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

  /**
   * get_item: full transcript, summary and metadata for one item — GATED by the
   * JJ-21/JJ-86 sensitivity guard exactly like search_memory. A sensitive/secret
   * or not-yet-classified item has all its content (transcript, summary, capture
   * metadata AND its title) WITHHELD and `redacted: true`; only the item's id,
   * source type and timestamps remain, so an external model can never read
   * sensitive content by fetching a known id directly (the previous behavior
   * returned full content unconditionally).
   */
  async getItem(userId: string, args: { itemId: string }): Promise<GetItemResult> {
    const item = await this.inbox.getItem(userId, args.itemId);
    const allowed = await this.allowedItemIds([item.id]);
    if (!allowed.has(item.id)) {
      return {
        itemId: item.id,
        sourceType: item.sourceType,
        occurredAt: toIso(item.occurredAt),
        ingestedAt: toIso(item.ingestedAt),
        title: null,
        transcript: null,
        summary: null,
        metadata: null,
        redacted: true,
      };
    }
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
      redacted: false,
    };
  }

  /**
   * list_recent_items: newest-first page of the user's memory — GATED so
   * sensitive/secret and not-yet-classified items are NOT enumerated at all
   * (JJ-86). The previous behavior listed every id unconditionally, letting an
   * external model walk held items and then fetch each with get_item, bypassing
   * the search-retrieval tier filter. `nextCursor` is preserved so pagination
   * still advances even when a page is fully filtered.
   */
  async listRecentItems(
    userId: string,
    args: { limit: number; cursor?: string },
  ): Promise<{ items: RecentItemResult[]; nextCursor: string | null }> {
    const { items, nextCursor } = await this.inbox.listItems(userId, args.limit, args.cursor);
    const allowed = await this.allowedItemIds(items.map((i) => i.id));
    return {
      items: items
        .filter((item) => allowed.has(item.id))
        .map((item) => {
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
   * UUID, so repeat calls create distinct notes unless the caller pins a key. An
   * optional `title` is stored under the same `metadata.tags.title` slot the read
   * tools surface as an item's title (cheap metadata reuse — no new field). This
   * is a WRITE, so it is recorded in the audit trail like the other mutations.
   */
  async ingestTextNote(
    actor: McpActor,
    args: { text: string; occurredAt?: string; idempotencyKey?: string; title?: string },
  ): Promise<{ itemId: string }> {
    const title = args.title?.trim();
    const item = await this.ingestion.ingestText(actor.userId, {
      text: args.text,
      occurredAt: args.occurredAt ?? new Date().toISOString(),
      idempotencyKey: args.idempotencyKey ?? `mcp-note-${randomUUID()}`,
      metadata: title ? { tags: { title } } : undefined,
    });
    await this.audit.recordMcpMutation({
      userId: actor.userId,
      tokenPrefix: actor.tokenPrefix,
      tool: 'ingest_text_note',
      itemId: item.id,
      change: { itemId: item.id, title: title ?? null },
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
   * touching one entity, plus the connected neighbors' names. Each edge is gated
   * by its OWN evidence — an edge shows only when at least one of the recordings
   * it was extracted from is externally allowed (so "A spouse_of B" asserted
   * solely from a secret recording is dropped even when A and B are both visible
   * elsewhere) AND its neighbor is itself visible. `evidenceCount` is recomputed
   * from the surviving (allowed) evidence. Optional `relationType`; paginated.
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
    const evidence = await this.entityGraph.edgeEvidenceItemIds(
      userId,
      args.entityId,
      args.relationType,
      false,
    );
    const allowedEvidence = await this.allowedItemIds([...evidence.values()].flat());
    const neighborIds = [
      ...new Set(edges.flatMap((e) => [e.sourceEntityId, e.targetEntityId])),
    ].filter((id) => id !== args.entityId);
    const visibleNeighbors = await this.visibleEntityIds(userId, neighborIds);
    const gated = edges.flatMap((e) => {
      const other = e.sourceEntityId === args.entityId ? e.targetEntityId : e.sourceEntityId;
      if (!visibleNeighbors.has(other)) return [];
      const allowedItems = (evidence.get(edgeKey(e)) ?? []).filter((i) => allowedEvidence.has(i));
      if (allowedItems.length === 0) return []; // no non-sensitive evidence — fail closed
      return [{ ...e, evidenceCount: allowedItems.length }];
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
    // Keep a fact only if ≥1 citation survives, and recompute citationCount from
    // the SURVIVING (allowed) citations so a dropped sensitive source never even
    // shows up in the count (mirrors the dossier's per-fact redaction).
    const gated = facts.flatMap((f) => {
      const allowedItems = new Set(
        (citationRefs.get(f.id) ?? [])
          .filter((r) => allowed.has(r.inboxItemId))
          .map((r) => r.inboxItemId),
      );
      if (allowedItems.size === 0) return [];
      return [{ fact: f, citationCount: allowedItems.size }];
    });
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { facts: page.map(({ fact, citationCount }) => toFactListEntry(fact, citationCount)), nextCursor };
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
    const rows = await this.tasks.listForMcp(userId, args.status);
    const allowed = await this.allowedItemIds(rows.flatMap((r) => r.citationItemIds));
    // A citation-less user-created task (hasCitations=false) has no item-derived
    // content to gate, so it surfaces directly; a cited task survives only when
    // ≥1 of its source items may cross this external surface (FAIL CLOSED — this
    // keeps reaped ghosts and sensitive-only tasks hidden, as before).
    const gated = rows
      .filter((r) => !r.hasCitations || r.citationItemIds.some((i) => allowed.has(i)))
      .map((r) => r.task);
    const { page, nextCursor } = paginate(gated, args.limit, args.cursor);
    return { tasks: page, nextCursor };
  }

  // ---- JJ-78 follow-up: MUTATION tools ----
  //
  // External agents don't just read the memory, they act on it: create a task,
  // resolve a task/commitment, answer a question. Each mutation (a) REUSES the
  // domain service's write path (no business logic re-implemented here), (b) is
  // GATED exactly like the read tools — a mutation on an item whose source
  // recording may not cross this external surface (sensitive/secret OR not-yet-
  // classified: FAIL CLOSED) is refused as if the item did not exist, and (c) is
  // recorded in the audit trail (which token, what changed, when) AFTER it lands.
  // Status writes are the user's own fields, which re-extraction never clobbers,
  // and go through race-safe conditional updates.

  /**
   * create_task: create a user-owned task the pipeline never produced (no source
   * recording, so no citations). Returns the created task. NB: `notes` is not
   * accepted — the `tasks` table has no notes column and this lane ships no
   * migration; a note would have nowhere durable to live.
   */
  async createTask(
    actor: McpActor,
    args: { title: string; dueDate?: string },
  ): Promise<TaskDto> {
    const task = await this.tasks.createUserTask(actor.userId, {
      title: args.title,
      dueDate: args.dueDate ?? null,
    });
    await this.audit.recordMcpMutation({
      userId: actor.userId,
      tokenPrefix: actor.tokenPrefix,
      tool: 'create_task',
      itemId: null,
      change: { taskId: task.id, title: task.title, dueDate: task.dueDate },
    });
    return task;
  }

  /**
   * update_task_status: advance a task's user-owned status (open → completed /
   * dismissed, or reopen). Refused for a task whose source items are all gated
   * (fail closed); a citation-less user-created task is always mutable. The flip
   * is race-safe (conditional UPDATE … WHERE status=:expected).
   */
  async updateTaskStatus(
    actor: McpActor,
    args: { taskId: string; status: TaskStatus },
  ): Promise<TaskDto> {
    const found = await this.tasks.findForMcpMutation(actor.userId, args.taskId);
    if (!found) throw new NotFoundException('task not found');
    if (found.hasCitations) {
      const allowed = await this.allowedItemIds(found.citationItemIds);
      if (!found.citationItemIds.some((i) => allowed.has(i))) {
        throw new NotFoundException('task not found'); // gated — refuse, don't confirm
      }
    }
    const updated = await this.tasks.setStatusIfUnchanged(
      actor.userId,
      args.taskId,
      found.status,
      args.status,
    );
    await this.audit.recordMcpMutation({
      userId: actor.userId,
      tokenPrefix: actor.tokenPrefix,
      tool: 'update_task_status',
      itemId: null,
      change: { taskId: args.taskId, from: found.status, to: args.status },
    });
    return updated;
  }

  /**
   * update_commitment_status: advance a commitment's user-owned status (open →
   * fulfilled / dismissed) — commitments exist in both directions. Refused when
   * the commitment's source item may not cross this surface (fail closed). The
   * flip is race-safe.
   */
  async updateCommitmentStatus(
    actor: McpActor,
    args: { commitmentId: string; status: CommitmentStatus },
  ): Promise<CommitmentDto> {
    const found = await this.commitments.findForStatusUpdate(actor.userId, args.commitmentId);
    if (!found) throw new NotFoundException('commitment not found');
    await this.assertItemUngated(found.inboxItemId, 'commitment not found');
    const updated = await this.commitments.setStatusIfUnchanged(
      actor.userId,
      args.commitmentId,
      found.status,
      args.status,
    );
    await this.audit.recordMcpMutation({
      userId: actor.userId,
      tokenPrefix: actor.tokenPrefix,
      tool: 'update_commitment_status',
      itemId: found.inboxItemId,
      change: { commitmentId: args.commitmentId, from: found.status, to: args.status },
    });
    return updated;
  }

  /**
   * answer_question: mark an OPEN question answered, durably recording the
   * answer text on the question row (user-owned `answer` column — re-extraction
   * never touches it) with a race-safe flip. Refused when the question's source
   * item may not cross this surface (fail closed), and refused with Conflict
   * when the question is not open — an external agent must never override the
   * owner's settled resolution (a user's `dropped` means "I won't answer this",
   * and an existing `answered` must not be silently rewritten).
   */
  async answerQuestion(
    actor: McpActor,
    args: { questionId: string; answer: string },
  ): Promise<QuestionDto> {
    const found = await this.questions.findForStatusUpdate(actor.userId, args.questionId);
    if (!found) throw new NotFoundException('question not found');
    await this.assertItemUngated(found.inboxItemId, 'question not found');
    if (found.status !== 'open') {
      throw new ConflictException(`question is ${found.status}, not open — only open questions can be answered`);
    }
    const updated = await this.questions.setStatusIfUnchanged(
      actor.userId,
      args.questionId,
      'open',
      'answered',
      args.answer,
    );
    await this.audit.recordMcpMutation({
      userId: actor.userId,
      tokenPrefix: actor.tokenPrefix,
      tool: 'answer_question',
      itemId: found.inboxItemId,
      change: {
        questionId: args.questionId,
        from: found.status,
        to: 'answered',
        answer: args.answer,
      },
    });
    return updated;
  }

  /**
   * Refuse a mutation whose single source item may not cross this external
   * surface — the item's effective tier is local-only OR not yet classified
   * (FAIL CLOSED), mirroring the read tools. Throws NotFound so the surface never
   * even confirms the gated item exists.
   */
  private async assertItemUngated(inboxItemId: string, message: string): Promise<void> {
    const allowed = await this.allowedItemIds([inboxItemId]);
    if (!allowed.has(inboxItemId)) throw new NotFoundException(message);
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
   * get_journal: one rollup's composed narrative for a period. A day entry cites
   * its source items directly (`kind: 'item'`); a week/month rollup composes from
   * child DAY narratives and a year from child MONTHS, citing them as
   * `kind: 'journal'` (refId = the child period key) — so its own citations carry
   * NO item ids. To avoid leaking sensitive content that a rollup transitively
   * summarizes, child-journal citations are resolved recursively down to their
   * item citations and ALL are gated. The markdown body is returned only when
   * every transitively-reachable source item is externally allowed AND every
   * child journal resolved; otherwise it is withheld (`markdown` null,
   * `redacted` true) and disallowed direct item citations are dropped.
   */
  async getJournal(
    userId: string,
    args: { periodType: JournalPeriodType; periodKey: string },
  ): Promise<JournalDocumentResponse & { redacted: boolean }> {
    const doc = await this.journal.getJournal(userId, args.periodType, args.periodKey);
    const { itemRefs, resolvable } = await this.collectJournalItemRefs(
      userId,
      args.periodType,
      doc,
    );
    const allowed = await this.allowedItemIds(itemRefs);
    const citationsAllowed = resolvable && itemRefs.every((r) => allowed.has(r));
    if (citationsAllowed && !journalBodyUnderCited(doc)) {
      return { ...doc, redacted: false };
    }
    return {
      ...doc,
      markdown: null,
      citations: doc.citations.filter((c) => !(c.kind === 'item' && !allowed.has(c.refId))),
      redacted: true,
    };
  }

  /**
   * Every source-item id a journal document transitively derives from, following
   * `kind: 'journal'` citations down into child periods (year → months → days).
   * `resolvable` is false — forcing get_journal to fail closed — if any child
   * journal can't be re-derived to a current succeeded version (deleted/failed,
   * so its embedded narrative can't be re-gated) or the recursion is impossibly
   * deep. `kind: 'event'` citations are calendar-feed (not item) content and are
   * ignored, mirroring list_calendar_events.
   */
  private async collectJournalItemRefs(
    userId: string,
    periodType: JournalPeriodType,
    doc: { citations: JournalCitation[]; version: number | null },
    depth = 0,
  ): Promise<{ itemRefs: string[]; resolvable: boolean }> {
    if (depth > 4) return { itemRefs: [], resolvable: false };
    const itemRefs: string[] = [];
    let resolvable = true;
    for (const c of doc.citations) {
      if (c.kind === 'item') {
        itemRefs.push(c.refId);
      } else if (c.kind === 'journal') {
        if (periodType === 'day') {
          // A day entry citing a journal is unexpected; can't resolve it → fail closed.
          resolvable = false;
          continue;
        }
        const child = await this.journal.getJournal(userId, childTypeOf(periodType), c.refId);
        // No current succeeded version ⇒ the parent embedded a narrative we can
        // no longer re-derive/re-gate. Fail closed.
        if (child.version === null) {
          resolvable = false;
          continue;
        }
        const nested = await this.collectJournalItemRefs(
          userId,
          childTypeOf(periodType),
          child,
          depth + 1,
        );
        itemRefs.push(...nested.itemRefs);
        if (!nested.resolvable) resolvable = false;
      }
    }
    return { itemRefs, resolvable };
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

    // Relations: keep an edge only when its OTHER endpoint is visible AND at
    // least one recording it was extracted from is externally allowed (so an
    // edge asserted solely from a sensitive item is dropped even if both its
    // entities are visible elsewhere). The dossier's neighborhood includes weak
    // co-occurrence edges, so evidence is fetched with includeCooccurrence=true
    // to line up with dossier.relations. evidenceCount is recomputed from the
    // surviving evidence.
    const visibleNeighbors = await this.visibleEntityIds(
      userId,
      dossier.neighbors.map((n) => n.id),
    );
    const edgeEvidence = await this.entityGraph.edgeEvidenceItemIds(
      userId,
      dossier.entity.id,
      undefined,
      true,
    );
    const allowedEdgeEvidence = await this.allowedItemIds([...edgeEvidence.values()].flat());
    const relations = dossier.relations.flatMap((e) => {
      const other =
        e.sourceEntityId === dossier.entity.id ? e.targetEntityId : e.sourceEntityId;
      if (other !== dossier.entity.id && !visibleNeighbors.has(other)) return [];
      const allowedItems = (edgeEvidence.get(edgeKey(e)) ?? []).filter((i) =>
        allowedEdgeEvidence.has(i),
      );
      if (allowedItems.length === 0) return [];
      return [{ ...e, evidenceCount: allowedItems.length }];
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

function toFactListEntry(f: PersonalFactDto, citationCount: number): FactListEntry {
  return {
    id: f.id,
    personEntityId: f.personEntityId,
    personName: f.personName,
    attribute: f.attribute,
    value: f.value,
    active: f.active,
    exclusive: f.exclusive,
    citationCount,
    lastSeenAt: f.lastSeenAt,
  };
}

/**
 * Whether a journal body must be WITHHELD over MCP for lack of trustworthy
 * citations (JJ-86 under-citation leak fold-in), independent of the per-item
 * tier gate. A rollup composed from child journals carries no item ids of its
 * own, and get_journal trusts citation completeness to tier-gate — so a body
 * with prose but ZERO traceable (item/journal) citations, or one whose
 * structural citation-coverage confidence is `low` (enough claims lack a `[n]`
 * marker that it can't be verified against sources), is treated as unverifiable
 * and its body is not shown. An empty body has nothing to leak.
 */
function journalBodyUnderCited(doc: {
  markdown: string | null;
  citations: JournalCitation[];
}): boolean {
  const markdown = doc.markdown ?? '';
  if (markdown.trim().length === 0) return false;
  const traceable = doc.citations.filter((c) => c.kind === 'item' || c.kind === 'journal');
  if (traceable.length === 0) return true;
  return analyzeCitationCoverage(markdown).confidence === 'low';
}

/** The `toEdges` grouping key for one aggregated relation edge (JJ-78 gating). */
function edgeKey(e: EntityRelationEdgeDto): string {
  return `${e.sourceEntityId}:${e.targetEntityId}:${e.relationType}`;
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
