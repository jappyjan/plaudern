import { z } from 'zod';
import { extractionKindSchema, extractionStatusSchema } from './inbox';

/**
 * Server-sent events pushed on `GET /api/v1/events`.
 * Events carry ids only — clients refetch the affected item (or drop it, for
 * `item.deleted`), so a missed event (or a reconnect) is recovered by
 * refetching, never by replay.
 */
export const inboxEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item.created'), itemId: z.string().uuid() }),
  z.object({ type: z.literal('item.committed'), itemId: z.string().uuid() }),
  z.object({ type: z.literal('item.deleted'), itemId: z.string().uuid() }),
  z.object({
    type: z.literal('extraction.updated'),
    itemId: z.string().uuid(),
    extractionId: z.string().uuid(),
    kind: extractionKindSchema,
    status: extractionStatusSchema,
  }),
  /** Keep-alive so proxies do not drop idle SSE connections. */
  z.object({ type: z.literal('heartbeat') }),
]);
export type InboxEvent = z.infer<typeof inboxEventSchema>;
