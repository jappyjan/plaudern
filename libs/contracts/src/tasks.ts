import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `tasks` extraction kind (JJ-35): an LLM reads a recording's
 * transcript/summary and pulls out the user's own self-directed intentions
 * ("I need to book the dentist"), which are deduplicated — SEMANTICALLY, via
 * embeddings when configured — into a per-user **task list**. Ten mentions of
 * the same errand across ten recordings collapse into ONE open task carrying ten
 * citations, not ten duplicates.
 *
 * A `tasks` row lives outside the immutable inbox aggregate (its status is
 * mutable: open → completed/dismissed), exactly like a topic or a registry
 * entity. `task_citations` are the extraction-scoped edges back to the
 * recordings that mentioned it — the read models count only the latest succeeded
 * extraction per item, so append-only reprocessing supersedes old citations.
 */

/** Lifecycle of a task. `dismissed` = the user rejected the extraction. */
export const taskStatusSchema = z.enum(['open', 'completed', 'dismissed']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * One candidate task as produced by the LLM, before it is deduped into the
 * per-user task list. `title` is a short imperative ("Book the dentist");
 * `dueDate` is an ISO date the model resolved from the recording (optional);
 * `quote` is the exact sentence it was inferred from, used to build a citation.
 */
export const extractedTaskSchema = z.object({
  /** Short imperative phrasing of the intention. Bounded — LLM output is untrusted. */
  title: z.string().min(1).max(300),
  /** ISO-8601 date the task is due, when the recording implies one; else null. */
  dueDate: z.string().max(40).nullish(),
  /** The source sentence the task was inferred from (for the citation). */
  quote: z.string().max(1000).nullish(),
});
export type ExtractedTask = z.infer<typeof extractedTaskSchema>;

/**
 * The persisted shape of a `tasks` extraction's `content` (stored as JSON on
 * the append-only extracted_payloads row). The deduped tasks and their
 * citations live in the `tasks` / `task_citations` tables; this is just the
 * provenance/summary the read model needs without a join.
 */
export const taskExtractionPayloadSchema = z.object({
  model: z.string().nullable(),
  /** How many distinct tasks this extraction cited (new or matched). */
  taskCount: z.number().int().nonnegative(),
});
export type TaskExtractionPayload = z.infer<typeof taskExtractionPayloadSchema>;

/**
 * A deduped task in the per-user list. Mutable (status resolves, citations
 * accrete), so it lives outside the immutable inbox aggregate — like a topic.
 */
export const taskSchema = z.object({
  id: z.string().uuid(),
  /** Canonical imperative title. */
  title: z.string(),
  status: taskStatusSchema,
  /** ISO date the task is due, when known; else null. */
  dueDate: z.string().nullable(),
  /** Distinct recordings that mention this task (latest extraction per item only). */
  citationCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskDto = z.infer<typeof taskSchema>;

/**
 * A task cited by a specific recording — the unit an item's tasks tab renders.
 * Carries the citation's quote/segment (from THIS recording) alongside the
 * deduped task's canonical fields.
 */
export const taskCitationSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  status: taskStatusSchema,
  dueDate: z.string().nullable(),
  /** The sentence this recording mentioned the task in; null if not captured. */
  quote: z.string().nullable(),
  /** Segment start/end (seconds) into the recording, when the quote was located. */
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
});
export type TaskCitationDto = z.infer<typeof taskCitationSchema>;

/** Task list query: optionally filter to a single status. */
export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const taskListResponseSchema = z.object({
  tasks: z.array(taskSchema),
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

/** Update a task's lifecycle status (complete it, dismiss it, reopen it). */
export const updateTaskStatusRequestSchema = z.object({
  status: taskStatusSchema,
});
export type UpdateTaskStatusRequest = z.infer<typeof updateTaskStatusRequestSchema>;

/**
 * Read model for an item's tasks tab. `status` tracks the async pipeline step so
 * the UI can show a spinner while extraction runs and render nothing when the
 * item has not been processed yet.
 */
export const itemTasksResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  tasks: z.array(taskCitationSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemTasksResponse = z.infer<typeof itemTasksResponseSchema>;
