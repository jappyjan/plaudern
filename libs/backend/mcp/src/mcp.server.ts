import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_LIST_MIN_LIMIT,
  MCP_SEARCH_DEFAULT_LIMIT,
  MCP_SEARCH_MAX_LIMIT,
  MCP_SEARCH_MIN_LIMIT,
} from '@plaudern/contracts';
import type { McpToolsService } from './mcp.tools';

/** Server identity advertised to MCP clients on initialize. */
const SERVER_INFO = { name: 'plaudern-memory', version: '0.1.0' } as const;

/** Wrap any JSON-serializable payload as the SDK's text tool result. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Build a fresh MCP server bound to one authenticated user, exposing the four
 * memory tools. A new instance is created per request (stateless transport), so
 * the closed-over `userId` scopes every tool call to the token owner.
 *
 * Tool names/descriptions are chosen so future capabilities can slot in without
 * renaming these: `search_memory` runs the full hybrid pipeline (keyword FTS +
 * semantic pgvector fused with RRF, JJ-38; structured filters can extend it),
 * and the read/list/capture verbs stay stable as dossiers or open-loops arrive
 * later.
 */
export function buildMcpServer(userId: string, tools: McpToolsService): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Plaudern is the user\'s personal memory of their recordings, notes and clips. ' +
      'Use search_memory to find relevant past content, get_item to read a full ' +
      'transcript/summary, list_recent_items to browse the latest, and ' +
      'ingest_text_note to capture a new note into the memory.',
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
    async (args) => jsonResult(await tools.ingestTextNote(userId, args)),
  );

  return server;
}
