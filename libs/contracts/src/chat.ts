import { z } from 'zod';
import { sourceTypeSchema } from './source-type';

/**
 * Memory chat (JJ-37): conversational Q&A over everything captured, answered
 * ONLY from passages retrieved by the hybrid search pipeline. Citations are
 * structural, not aspirational (VISION §4/§6): the model must reference the
 * numbered sources it was given via `[n]` markers, the server strips markers
 * pointing at sources it never provided, an answer that carries no valid
 * citation is replaced by an explicit "I can't back this up" response, and
 * answers with uncited claims are downgraded to low confidence ("I think —
 * check the source"). Each citation deep-links to the inbox item and, when the
 * passage came from a transcript segment, to the audio timestamp.
 */

export const chatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/**
 * Answer confidence as enforced by the server. `low` means "I think — check
 * the source": the model hedged, or some claims lacked citations.
 */
export const chatConfidenceSchema = z.enum(['high', 'low']);
export type ChatConfidence = z.infer<typeof chatConfidenceSchema>;

/**
 * One cited source of an assistant answer. `marker` is the number the answer
 * text references as `[n]`; `startSeconds` is the transcript-segment offset for
 * the audio deep link (null when the passage came from a summary or a
 * non-audio item).
 */
export const chatCitationSchema = z.object({
  marker: z.number().int().positive(),
  inboxItemId: z.string(),
  title: z.string().nullable(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string(),
  /** The retrieved passage the claim rests on (highlight markers stripped). */
  snippet: z.string().nullable(),
  /** Transcript segment window (seconds) when known; null otherwise. */
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
});
export type ChatCitation = z.infer<typeof chatCitationSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: chatRoleSchema,
  /** Message text; assistant answers carry inline `[n]` citation markers. */
  content: z.string(),
  /** Sources backing the answer; always empty for user messages. */
  citations: z.array(chatCitationSchema),
  /** Server-enforced confidence; null for user messages. */
  confidence: chatConfidenceSchema.nullable(),
  createdAt: z.string(),
});
export type ChatMessageDto = z.infer<typeof chatMessageSchema>;

export const chatConversationSchema = z.object({
  id: z.string().uuid(),
  /** Auto-titled from the first question. */
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatConversationDto = z.infer<typeof chatConversationSchema>;

export const chatConversationListResponseSchema = z.object({
  conversations: z.array(chatConversationSchema),
});
export type ChatConversationListResponse = z.infer<typeof chatConversationListResponseSchema>;

export const chatConversationDetailSchema = z.object({
  conversation: chatConversationSchema,
  /** Oldest first. */
  messages: z.array(chatMessageSchema),
});
export type ChatConversationDetailDto = z.infer<typeof chatConversationDetailSchema>;

/** Ask a question; omit `conversationId` to start a new conversation. */
export const chatAskRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
});
export type ChatAskRequest = z.infer<typeof chatAskRequestSchema>;

export const chatAskResponseSchema = z.object({
  conversationId: z.string().uuid(),
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
});
export type ChatAskResponse = z.infer<typeof chatAskResponseSchema>;

/**
 * Whether chat can run at all (the feature ships disabled until CHAT_API_KEY —
 * or the summarization key it falls back to — is configured).
 */
export const chatStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type ChatStatusDto = z.infer<typeof chatStatusSchema>;
