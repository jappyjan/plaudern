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

/**
 * Taxonomy proposals from embedding clusters (JJ-64). A recurring/on-demand job
 * clusters recent items' embeddings (pgvector), labels each cluster with the
 * LLM, and surfaces a suggestion like "14 recent items mention 'Hausbau' —
 * create a project?". Accepting one creates the topic in the taxonomy and
 * reclassifies the cluster's items; dismissing one suppresses that cluster from
 * being proposed again.
 */
export const topicProposalStatusSchema = z.enum(['pending', 'accepted', 'dismissed']);
export type TopicProposalStatus = z.infer<typeof topicProposalStatusSchema>;

export const topicProposalSchema = z.object({
  id: z.string().uuid(),
  /** LLM-suggested topic name for the cluster. */
  label: z.string(),
  /** LLM-suggested one-line description, when available. */
  description: z.string().nullable(),
  /** Number of items in the cluster. */
  itemCount: z.number().int().nonnegative(),
  /** A few representative member item ids, for a preview. */
  sampleItemIds: z.array(z.string().uuid()),
  status: topicProposalStatusSchema,
  /** The taxonomy topic created when the proposal was accepted, else null. */
  acceptedTopicId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TopicProposalDto = z.infer<typeof topicProposalSchema>;

/**
 * Status of the latest proposal-generation run for the user (JJ-69). Generation
 * moved to the queue/worker because labeling up to N clusters with inline LLM
 * calls could take minutes and time out behind a proxy: `POST generate` now
 * enqueues and returns immediately, and the UI polls the list endpoint until
 * `status` settles to `succeeded`/`failed`. `status` is null when the user has
 * never generated. `queued`/`processing` mean a run is in flight (the Suggest
 * button coalesces a double-click onto it rather than enqueuing a duplicate).
 */
export const topicProposalGenerationSchema = z.object({
  status: extractionStatusSchema.nullable(),
  /** Failure reason of the latest run when it failed; null otherwise. */
  error: z.string().nullable(),
  /** When the latest run was last touched; null when there has never been one. */
  updatedAt: z.string().datetime().nullable(),
});
export type TopicProposalGeneration = z.infer<typeof topicProposalGenerationSchema>;

/**
 * The proposals surfaced in the topics UI plus whether the feature can run at
 * all. `enabled` is false when embeddings or the labeling LLM are unconfigured,
 * so the UI hides the section instead of offering a button that always fails.
 * `generation` reports the async run state so the UI can spin + poll (JJ-69).
 * Optional (not just nullable-inside) so a NEW web bundle talking to an OLD API
 * during a deploy window still parses — absent means "no run tracking on this
 * server" and the UI treats it as "no run in flight".
 */
export const topicProposalListResponseSchema = z.object({
  proposals: z.array(topicProposalSchema),
  enabled: z.boolean(),
  generation: topicProposalGenerationSchema.optional(),
});
export type TopicProposalListResponse = z.infer<typeof topicProposalListResponseSchema>;

/**
 * Living topic documents (JJ-12): an evergreen, self-updating Markdown document
 * the AI maintains for each topic — current state, timeline, decisions, open
 * items, people involved. It regenerates whenever a new item classifies into
 * the topic, and EVERY statement cites its source items structurally (the body
 * carries inline `[n]` markers resolved against `citations`, exactly like the
 * memory chat answer in `chat.ts`). Each generation is stored as a new version
 * so the topic's evolution stays visible.
 */

/**
 * One cited source of a living document. `marker` is the number the body
 * references as `[n]`; it deep-links to the inbox item (and, when a transcript
 * segment offset is known, to the audio moment — null for summary-level
 * sources), mirroring `chatCitationSchema` so the same renderer works.
 */
export const topicDocumentCitationSchema = z.object({
  marker: z.number().int().positive(),
  inboxItemId: z.string(),
  title: z.string().nullable(),
  occurredAt: z.string().datetime(),
  /** Short excerpt of the source the claim rests on, when captured. */
  snippet: z.string().nullable(),
  /** Transcript segment start (seconds) for an audio deep link; null otherwise. */
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
});
export type TopicDocumentCitation = z.infer<typeof topicDocumentCitationSchema>;

/**
 * The persisted shape of a generation's `citations` column — the structural
 * source list a version was produced from.
 */
export const topicDocumentCitationsPayloadSchema = z.array(topicDocumentCitationSchema);
export type TopicDocumentCitationsPayload = z.infer<typeof topicDocumentCitationsPayloadSchema>;

/**
 * Read model for a topic's living document. `status` is the state of the most
 * recent generation attempt (so the UI can show a spinner while a fresh version
 * is being written); `markdown`/`citations`/`version` describe the current
 * (latest succeeded) document, which stays visible during a regeneration and
 * after a failed attempt. `enabled` is false when generation is unconfigured,
 * so the UI hides the feature instead of offering an action that always fails.
 */
export const topicDocumentResponseSchema = z.object({
  topicId: z.string().uuid(),
  status: extractionStatusSchema.nullable(),
  version: z.number().int().positive().nullable(),
  markdown: z.string().nullable(),
  citations: z.array(topicDocumentCitationSchema),
  /**
   * Structural citation-coverage signal (JJ-20): `low` means enough of the
   * document's claims lack a citation that the reader should treat it as
   * "I think — check the sources" rather than settled memory. Derived at read
   * time from clause-level coverage; null when there is no succeeded document.
   */
  confidence: z.enum(['high', 'low']).nullable(),
  sourceItemCount: z.number().int().nonnegative().nullable(),
  model: z.string().nullable(),
  /** Error of the most recent attempt when it failed; null otherwise. */
  error: z.string().nullable(),
  /** When the current (visible) document was generated. */
  generatedAt: z.string().datetime().nullable(),
  /** When the most recent attempt (any status) was last touched. */
  updatedAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
});
export type TopicDocumentResponse = z.infer<typeof topicDocumentResponseSchema>;

/** One entry in a document's version history — metadata only (no body). */
export const topicDocumentVersionSchema = z.object({
  version: z.number().int().positive(),
  sourceItemCount: z.number().int().nonnegative(),
  model: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TopicDocumentVersionDto = z.infer<typeof topicDocumentVersionSchema>;

export const topicDocumentVersionListResponseSchema = z.object({
  topicId: z.string().uuid(),
  /** Succeeded versions, newest first. */
  versions: z.array(topicDocumentVersionSchema),
});
export type TopicDocumentVersionListResponse = z.infer<
  typeof topicDocumentVersionListResponseSchema
>;

/** A single historical version rendered in full — the body plus its citations. */
export const topicDocumentVersionDetailSchema = z.object({
  topicId: z.string().uuid(),
  version: z.number().int().positive(),
  markdown: z.string(),
  citations: z.array(topicDocumentCitationSchema),
  /** Clause-level citation-coverage signal for this version (JJ-20). */
  confidence: z.enum(['high', 'low']),
  sourceItemCount: z.number().int().nonnegative(),
  model: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TopicDocumentVersionDetailDto = z.infer<typeof topicDocumentVersionDetailSchema>;
