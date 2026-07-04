import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for topic/project classification (JJ-18): a user-editable taxonomy
 * of topics/projects plus the zero-shot `topics` extraction that tags each
 * inbox item against it.
 */

/**
 * One taxonomy entry — a topic or project the user cares about. Mutable
 * configuration (name/description/archived), so it lives outside the immutable
 * inbox aggregate. Archiving hides a topic from future classification without
 * losing the historical assignments that already reference it.
 */
export const topicSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TopicDto = z.infer<typeof topicSchema>;

export const topicListResponseSchema = z.object({
  topics: z.array(topicSchema),
});
export type TopicListResponse = z.infer<typeof topicListResponseSchema>;

/** Create a taxonomy entry. Names are trimmed; a description is optional. */
export const createTopicRequestSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  description: z.string().trim().max(2000).optional(),
});
export type CreateTopicRequest = z.infer<typeof createTopicRequestSchema>;

/**
 * Partial update of a taxonomy entry. Every field is optional so the same
 * endpoint can rename, edit the description, or (un)archive; a null description
 * clears it.
 */
export const updateTopicRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field must be provided',
  });
export type UpdateTopicRequest = z.infer<typeof updateTopicRequestSchema>;

/**
 * A single topic assigned to an item, with the model's confidence (0..1). Kept
 * denormalized (name alongside topicId) so the read model renders without a
 * join and stays stable even if the topic is later renamed or removed.
 */
export const topicAssignmentSchema = z.object({
  topicId: z.string().uuid(),
  name: z.string(),
  confidence: z.number().min(0).max(1),
});
export type TopicAssignmentDto = z.infer<typeof topicAssignmentSchema>;

/**
 * The persisted shape of a `topics` extraction's `content` (stored as JSON on
 * the append-only extracted_payloads row). The assignments are also projected
 * into the `item_topics` table so "list items by topic" is a cheap query.
 */
export const topicClassificationPayloadSchema = z.object({
  model: z.string().nullable(),
  assignments: z.array(topicAssignmentSchema),
});
export type TopicClassificationPayload = z.infer<typeof topicClassificationPayloadSchema>;

/**
 * Read model for an item's topics tab. `status` tracks the async pipeline step
 * so the UI can show a spinner while classification runs and render nothing
 * when the item has not been classified yet.
 */
export const itemTopicsResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  assignments: z.array(topicAssignmentSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemTopicsResponse = z.infer<typeof itemTopicsResponseSchema>;

/** One item tagged with a topic — the unit of "list items by topic". */
export const topicItemSchema = z.object({
  inboxItemId: z.string().uuid(),
  confidence: z.number().min(0).max(1),
  occurredAt: z.string().datetime(),
});
export type TopicItemDto = z.infer<typeof topicItemSchema>;

export const topicItemsResponseSchema = z.object({
  topicId: z.string().uuid(),
  items: z.array(topicItemSchema),
});
export type TopicItemsResponse = z.infer<typeof topicItemsResponseSchema>;
