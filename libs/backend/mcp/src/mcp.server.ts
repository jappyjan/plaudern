import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_LIST_MIN_LIMIT,
  MCP_SEARCH_DEFAULT_LIMIT,
  MCP_SEARCH_MAX_LIMIT,
  MCP_SEARCH_MIN_LIMIT,
  commitmentDirectionSchema,
  commitmentStatusSchema,
  decisionStatusSchema,
  entityTypeSchema,
  journalPeriodTypeSchema,
  questionDirectionSchema,
  questionStatusSchema,
  relationTypeSchema,
  reminderStatusSchema,
  taskStatusSchema,
} from '@plaudern/contracts';
import type { McpActor, McpToolsService } from './mcp.tools';

/** Server identity advertised to MCP clients on initialize. */
const SERVER_INFO = { name: 'plaudern-memory', version: '0.1.0' } as const;

/** Wrap any JSON-serializable payload as the SDK's text tool result. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Build a fresh MCP server bound to one authenticated actor, exposing the memory
 * tools plus the JJ-78 knowledge-graph read tools and the mutation tools. A new
 * instance is created per request (stateless transport), so the closed-over
 * `actor` scopes every tool call to the token owner.
 *
 * The knowledge-graph tools (list_entities/get_entity/list_relations/list_facts/
 * list_tasks/list_commitments/list_questions/list_decisions/list_reminders/
 * list_topics/get_topic/list_journal_periods/get_journal/list_calendar_events)
 * wrap the same per-user read services the web app uses, and every one that
 * returns item-derived content routes it through the JJ-21 sensitivity gate:
 * sensitive/secret and not-yet-classified items are excluded (fail closed), so
 * this external surface can never leak what memory-chat would also withhold.
 *
 * The mutation tools (create_task/update_task_status/update_commitment_status/
 * answer_question, plus ingest_text_note) reuse the same domain write paths the
 * web app uses; each is gated by the SAME fail-closed sensitivity rule (a write
 * touching a gated/not-yet-classified item is refused) and recorded in the audit
 * trail. Statuses written here are the user's own fields, which re-extraction
 * never overwrites, and use race-safe conditional updates.
 */
export function buildMcpServer(actor: McpActor, tools: McpToolsService): McpServer {
  const userId = actor.userId;
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Plaudern is the user\'s personal memory: their recordings, notes and clips, ' +
      'plus the knowledge graph an extraction pipeline derives from them. ' +
      'Raw memory: search_memory finds relevant past content, get_item reads a full ' +
      'transcript/summary, list_recent_items browses the latest, ingest_text_note ' +
      'captures a new note. Knowledge graph (structured, derived data): list_entities ' +
      'and get_entity read the people/orgs/places registry and a full person dossier ' +
      '(facts, commitments, questions, relations, mentions); list_relations reads the ' +
      'typed edges between entities; list_facts reads durable personal facts; ' +
      'list_tasks, list_commitments, list_questions, list_decisions and list_reminders ' +
      'read the extracted open loops; list_topics and get_topic read the topic taxonomy ' +
      'and item assignments; list_journal_periods and get_journal read the daily/weekly/' +
      'monthly/yearly rollups; list_calendar_events reads calendar events and their ' +
      'linked recordings. Acting on the memory: create_task adds a task, ' +
      'update_task_status and update_commitment_status resolve open loops, and ' +
      'answer_question marks a question answered. Every tool is scoped to this user; ' +
      'sensitive content is filtered out and writes to sensitive items are refused. ' +
      'Compact list_* entries carry ids — pass them to the matching get_*/update_* for ' +
      'full detail, and page with the returned nextCursor.',
  });

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description:
        'Hybrid search over the user\'s memory (transcripts and summaries of their ' +
        'recordings, notes and web clips): keyword full-text search and semantic ' +
        'similarity, fused into one ranking. When semantic search is unconfigured it ' +
        'degrades to keyword-only automatically. Returns the best-matching snippets ' +
        'with a fused relevance score (higher is better; scores are rank-based, not ' +
        'cosine similarity) and the id of the item each came from — pass that id to ' +
        'get_item for the full content.',
      inputSchema: {
        // Bounded like other free-text inputs (cf. ingestWebRequestSchema's url cap).
        query: z.string().min(1).max(4096).describe('Natural-language search query.'),
        limit: z
          .number()
          .int()
          .min(MCP_SEARCH_MIN_LIMIT)
          .max(MCP_SEARCH_MAX_LIMIT)
          .default(MCP_SEARCH_DEFAULT_LIMIT)
          .describe('Maximum number of distinct items to return.'),
      },
    },
    async (args) => jsonResult(await tools.searchMemory(userId, args)),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get memory item',
      description:
        'Fetch the full detail of one memory item by id: its transcript, summary and ' +
        'capture metadata. Use the ids returned by search_memory or list_recent_items.',
      inputSchema: {
        itemId: z.string().uuid().describe('The id of the memory item to fetch.'),
      },
    },
    async (args) => jsonResult(await tools.getItem(userId, args)),
  );

  server.registerTool(
    'list_recent_items',
    {
      title: 'List recent items',
      description:
        'List the user\'s most recent memory items, newest first. Returns compact ' +
        'entries (id, title, timestamps); use get_item for full content. Supports ' +
        'cursor pagination via the returned nextCursor.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(MCP_LIST_MIN_LIMIT)
          .max(MCP_LIST_MAX_LIMIT)
          .default(MCP_LIST_DEFAULT_LIMIT)
          .describe('Maximum number of items to return.'),
        cursor: z
          .string()
          .uuid()
          .optional()
          .describe('Pagination cursor from a previous response\'s nextCursor.'),
      },
    },
    async (args) => jsonResult(await tools.listRecentItems(userId, args)),
  );

  server.registerTool(
    'ingest_text_note',
    {
      title: 'Capture text note',
      description:
        'Capture a plain-text note into the user\'s memory (it is processed like any ' +
        'other item and becomes searchable). Returns the id of the created item.',
      inputSchema: {
        // Generous but bounded — a note, not a document dump (web-clip text caps at 1M).
        text: z.string().min(1).max(100_000).describe('The note text to capture.'),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Optional title shown for the note.'),
        occurredAt: z
          .string()
          .datetime()
          .optional()
          .describe('When the note was captured (ISO 8601); defaults to now.'),
        idempotencyKey: z
          .string()
          .min(1)
          .optional()
          .describe('Optional dedupe key; repeat calls with the same key are a no-op.'),
      },
    },
    async (args) => jsonResult(await tools.ingestTextNote(actor, args)),
  );

  // ---- JJ-78 knowledge-graph read tools ----
  // Fresh schema instances per tool (factories) keep each inputSchema independent.
  const limitArg = () =>
    z
      .number()
      .int()
      .min(MCP_LIST_MIN_LIMIT)
      .max(MCP_LIST_MAX_LIMIT)
      .default(MCP_LIST_DEFAULT_LIMIT)
      .describe('Maximum number of entries to return.');
  const cursorArg = () =>
    z
      .string()
      .min(1)
      .optional()
      .describe('Pagination cursor from a previous response\'s nextCursor.');

  server.registerTool(
    'list_entities',
    {
      title: 'List entities',
      description:
        'List the people, organizations, places and other entities the extraction ' +
        'pipeline has recognized across the user\'s memory, newest activity first. ' +
        'Returns compact entries (id, type, canonicalName, aliases, mentionCount, ' +
        'linked contactName); pass an id to get_entity for the full dossier. Optional ' +
        'type filter and case-insensitive name/alias substring query. Cursor-paginated.',
      inputSchema: {
        type: entityTypeSchema.optional().describe('Restrict to one entity type.'),
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Case-insensitive substring matched against name and aliases.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listEntities(userId, args)),
  );

  server.registerTool(
    'get_entity',
    {
      title: 'Get entity dossier',
      description:
        'Fetch the full dossier for one entity: identity and aliases, durable personal ' +
        'facts, commitments both ways, open questions, knowledge-graph relations and ' +
        'neighbors, and the recent recordings that mention it — each cited to its ' +
        'source item. Use an id from list_entities.',
      inputSchema: {
        entityId: z.string().uuid().describe('The id of the entity to fetch.'),
      },
    },
    async (args) => jsonResult(await tools.getEntity(userId, args)),
  );

  server.registerTool(
    'list_relations',
    {
      title: 'List entity relations',
      description:
        'List the asserted knowledge-graph edges touching one entity (works_at, ' +
        'located_in, part_of, …), with the connected neighbors\' names. Weak ' +
        'same-recording co-occurrence edges are excluded. Optional relationType ' +
        'filter. Cursor-paginated.',
      inputSchema: {
        entityId: z.string().uuid().describe('The entity whose relations to list.'),
        relationType: relationTypeSchema.optional().describe('Restrict to one relation type.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listRelations(userId, args)),
  );

  server.registerTool(
    'list_facts',
    {
      title: 'List personal facts',
      description:
        'List durable personal facts about people (attribute/value pairs, e.g. ' +
        '"employer = Acme"), newest activity first. Optionally scope to one person by ' +
        'personEntityId, and include superseded (outdated) facts. Cursor-paginated.',
      inputSchema: {
        personEntityId: z
          .string()
          .uuid()
          .optional()
          .describe('Restrict to facts about one person entity.'),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe('Include superseded (outdated) facts. Default false.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listFacts(userId, args)),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List the to-dos the pipeline extracted from the user\'s recordings and notes, ' +
        'deduped across recordings, newest activity first. Optional status filter ' +
        '(open/completed/dismissed). Cursor-paginated.',
      inputSchema: {
        status: taskStatusSchema.optional().describe('Restrict to one task status.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listTasks(userId, args)),
  );

  server.registerTool(
    'list_commitments',
    {
      title: 'List commitments',
      description:
        'List promises the user made or received (owed_by_me / owed_to_me), with the ' +
        'counterparty, description and due date. Optional direction and status filters. ' +
        'Cursor-paginated.',
      inputSchema: {
        direction: commitmentDirectionSchema
          .optional()
          .describe('owed_by_me or owed_to_me.'),
        status: commitmentStatusSchema.optional().describe('open/fulfilled/dismissed.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listCommitments(userId, args)),
  );

  server.registerTool(
    'list_questions',
    {
      title: 'List open questions',
      description:
        'List questions the user asked or was asked (asked_by_me / asked_of_me), with ' +
        'the counterparty and status. Optional direction and status filters. ' +
        'Cursor-paginated.',
      inputSchema: {
        direction: questionDirectionSchema
          .optional()
          .describe('asked_by_me or asked_of_me.'),
        status: questionStatusSchema.optional().describe('open/answered/dropped.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listQuestions(userId, args)),
  );

  server.registerTool(
    'list_decisions',
    {
      title: 'List decisions',
      description:
        'List decisions recorded across the user\'s memory, with context, participants ' +
        'and status. Optional status filter and participantEntityId scope. ' +
        'Cursor-paginated.',
      inputSchema: {
        status: decisionStatusSchema.optional().describe('active/revisited/superseded.'),
        participantEntityId: z
          .string()
          .uuid()
          .optional()
          .describe('Restrict to decisions involving one entity.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listDecisions(userId, args)),
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description:
        'List time-based reminders extracted from the user\'s memory, soonest due first. ' +
        'Optional status filter and an inclusive dueAt window (from/to, ISO 8601). ' +
        'Cursor-paginated.',
      inputSchema: {
        status: reminderStatusSchema.optional().describe('active/done/dismissed.'),
        from: z
          .string()
          .datetime()
          .optional()
          .describe('Inclusive lower bound on dueAt (ISO 8601).'),
        to: z
          .string()
          .datetime()
          .optional()
          .describe('Inclusive upper bound on dueAt (ISO 8601).'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.listReminders(userId, args)),
  );

  server.registerTool(
    'list_topics',
    {
      title: 'List topics',
      description:
        'List the topic/project taxonomy the pipeline maintains, each with the count of ' +
        'items assigned to it. Use get_topic to read a topic\'s assigned items.',
      inputSchema: {},
    },
    async () => jsonResult(await tools.listTopics(userId)),
  );

  server.registerTool(
    'get_topic',
    {
      title: 'Get topic items',
      description:
        'List the memory items assigned to one topic (the item↔topic assignments), with ' +
        'each assignment\'s confidence and the item\'s occurredAt. Use a topic id from ' +
        'list_topics. Cursor-paginated.',
      inputSchema: {
        topicId: z.string().uuid().describe('The topic whose items to list.'),
        limit: limitArg(),
        cursor: cursorArg(),
      },
    },
    async (args) => jsonResult(await tools.getTopic(userId, args)),
  );

  server.registerTool(
    'list_journal_periods',
    {
      title: 'List journal periods',
      description:
        'List which journal rollups exist for a granularity (day/week/month/year), ' +
        'newest first — periodKey and metadata only. Pass a periodKey to get_journal ' +
        'for the composed narrative.',
      inputSchema: {
        periodType: journalPeriodTypeSchema.describe('day, week, month or year.'),
      },
    },
    async (args) => jsonResult(await tools.listJournalPeriods(userId, args)),
  );

  server.registerTool(
    'get_journal',
    {
      title: 'Get journal rollup',
      description:
        'Fetch one journal rollup\'s composed narrative for a period. periodType is ' +
        'day/week/month/year and periodKey is its key (e.g. 2026-06-14 for a day). ' +
        'Returns the markdown body with its citations; if any source item is sensitive ' +
        'the body is withheld and redacted is true.',
      inputSchema: {
        periodType: journalPeriodTypeSchema.describe('day, week, month or year.'),
        periodKey: z
          .string()
          .min(1)
          .max(32)
          .describe('The period key, e.g. 2026-06-14 (day) or 2026-W24 (week).'),
      },
    },
    async (args) => jsonResult(await tools.getJournal(userId, args)),
  );

  server.registerTool(
    'list_calendar_events',
    {
      title: 'List calendar events',
      description:
        'List calendar events overlapping a time window [from, to] (ISO 8601), earliest ' +
        'first, each with the ids of the recordings linked to it. Only recordings the ' +
        'user may surface externally are included in linkedRecordingIds.',
      inputSchema: {
        from: z.string().datetime().describe('Window start (ISO 8601).'),
        to: z.string().datetime().describe('Window end (ISO 8601).'),
      },
    },
    async (args) => jsonResult(await tools.listCalendarEvents(userId, args)),
  );

  // ---- JJ-78 follow-up: mutation tools ----
  // Each reuses the domain write path, is gated by the same fail-closed
  // sensitivity rule as the read tools, and is recorded in the audit trail.

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create a new task in the user\'s to-do list (a task the user authored ' +
        'directly, not extracted from a recording). Returns the created task. Note: ' +
        'free-form notes are not stored — pass the intent in the title.',
      inputSchema: {
        title: z.string().min(1).max(500).describe('The task title, e.g. "Book the dentist".'),
        dueDate: z
          .string()
          .datetime()
          .optional()
          .describe('Optional due date/time (ISO 8601).'),
      },
    },
    async (args) => jsonResult(await tools.createTask(actor, args)),
  );

  server.registerTool(
    'update_task_status',
    {
      title: 'Update task status',
      description:
        'Change a task\'s status: open, completed or dismissed (use open to reopen). ' +
        'Use an id from list_tasks. Returns the updated task.',
      inputSchema: {
        taskId: z.string().uuid().describe('The id of the task to update.'),
        status: taskStatusSchema.describe('The new status: open, completed or dismissed.'),
      },
    },
    async (args) => jsonResult(await tools.updateTaskStatus(actor, args)),
  );

  server.registerTool(
    'update_commitment_status',
    {
      title: 'Update commitment status',
      description:
        'Change a commitment\'s status: open, fulfilled or dismissed. Works for ' +
        'commitments in either direction (owed_by_me / owed_to_me). Use an id from ' +
        'list_commitments. Returns the updated commitment.',
      inputSchema: {
        commitmentId: z.string().uuid().describe('The id of the commitment to update.'),
        status: commitmentStatusSchema.describe(
          'The new status: open, fulfilled or dismissed.',
        ),
      },
    },
    async (args) => jsonResult(await tools.updateCommitmentStatus(actor, args)),
  );

  server.registerTool(
    'answer_question',
    {
      title: 'Answer question',
      description:
        'Mark an open question as answered, recording the answer text. Use an id from ' +
        'list_questions. Returns the updated question.',
      inputSchema: {
        questionId: z.string().uuid().describe('The id of the question to answer.'),
        answer: z.string().min(1).max(10_000).describe('The answer text.'),
      },
    },
    async (args) => jsonResult(await tools.answerQuestion(actor, args)),
  );

  return server;
}
