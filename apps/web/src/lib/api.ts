import { z } from 'zod';
import {
  calendarEventDetailSchema,
  calendarEventsResponseSchema,
  calendarFeedSchema,
  calendarFeedsResponseSchema,
  calendarFeedTestResponseSchema,
  calendarRecordingsResponseSchema,
  calendarSyncNowResponseSchema,
  emailSettingsSchema,
  geocodeResponseSchema,
  googleAuthUrlResponseSchema,
  googlePendingResponseSchema,
  inboxItemSchema,
  itemSensitivitySchema,
  inboxListResponseSchema,
  inboxPurgeResponseSchema,
  inboxSplitResponseSchema,
  ingestInitResponseSchema,
  itemEventsResponseSchema,
  linkResponseSchema,
  mcpTokenCreatedSchema,
  mcpTokenStatusSchema,
  plaudSettingsSchema,
  plaudSyncNowResponseSchema,
  plaudTestConnectionResponseSchema,
  consentSettingsSchema,
  speakerTranscriptSchema,
  summarizationSettingsSchema,
  summarySchema,
  voiceProfileDetailSchema,
  voiceProfileListResponseSchema,
  type CalendarEventDetailDto,
  type CalendarEventsResponse,
  type CalendarFeedDto,
  type CalendarFeedsResponse,
  type CalendarFeedTestResponse,
  type CalendarRecordingsResponse,
  type CalendarSyncNowResponse,
  type CreateCalendarFeedRequest,
  type EmailSettingsDto,
  type GeocodeResponse,
  type GoogleAuthUrlResponse,
  type GooglePendingResponse,
  type IngestInitRequest,
  type IngestInitResponse,
  type IngestTextRequest,
  type IngestWebRequest,
  type InboxItemDto,
  type InboxListResponse,
  type InboxPurgeResponse,
  type InboxSplitResponse,
  type McpTokenCreatedDto,
  type McpTokenStatusDto,
  type PlaudSettingsDto,
  type PlaudSyncNowResponse,
  type PlaudTestConnectionRequest,
  type PlaudTestConnectionResponse,
  type ItemEventsResponse,
  type LinkResponse,
  type ConsentSettingsDto,
  type SpeakerTranscriptDto,
  type SummarizationSettingsDto,
  type SummaryDto,
  type UpdateCalendarFeedRequest,
  type UpdateConsentSettingsRequest,
  type UpdateEmailSettingsRequest,
  type UpdateSummarizationSettingsRequest,
  type UpdatePlaudSettingsRequest,
  type UpdateVoiceProfileRequest,
  type VoiceProfileDetailDto,
  type VoiceProfileListResponse,
  notificationDispatchResultSchema,
  notificationPreferencesSchema,
  vapidPublicKeyResponseSchema,
  type NotificationDispatchResult,
  type NotificationPreferencesDto,
  type RegisterPushSubscriptionRequest,
  type SendTestNotificationRequest,
  type UpdateNotificationPreferencesRequest,
  type VapidPublicKeyResponse,
  itemTopicsResponseSchema,
  topicListResponseSchema,
  topicItemsResponseSchema,
  topicSchema,
  topicProposalListResponseSchema,
  topicDocumentResponseSchema,
  topicDocumentVersionListResponseSchema,
  topicDocumentVersionDetailSchema,
  journalDocumentResponseSchema,
  journalPeriodListResponseSchema,
  journalVersionListResponseSchema,
  journalVersionDetailSchema,
  type JournalDocumentResponse,
  type JournalPeriodListResponse,
  type JournalPeriodType,
  type JournalVersionDetailDto,
  type JournalVersionListResponse,
  type CreateTopicRequest,
  type ItemTopicsResponse,
  type TopicDto,
  type TopicItemsResponse,
  type TopicListResponse,
  type TopicProposalListResponse,
  type TopicDocumentResponse,
  type TopicDocumentVersionListResponse,
  type TopicDocumentVersionDetailDto,
  type UpdateTopicRequest,
  itemTasksResponseSchema,
  taskListResponseSchema,
  taskSchema,
  type ItemTasksResponse,
  type TaskDto,
  type TaskListResponse,
  type TaskStatus,
  entityListResponseSchema,
  entityDetailWithRelationsSchema,
  entityNeighborhoodResponseSchema,
  entityConnectResponseSchema,
  entityDossierSchema,
  autoLinkEntitiesResponseSchema,
  entityContactSuggestionsResponseSchema,
  duplicateCandidatesResponseSchema,
  mergeSuggestionsResponseSchema,
  reconcileResponseSchema,
  type AutoLinkEntitiesResponse,
  type EntityContactSuggestionsResponse,
  type DuplicateCandidatesResponse,
  type MergeSuggestionStatus,
  type MergeSuggestionsResponse,
  type ReconcileResponse,
  type EntityListResponse,
  type EntityDetailWithRelationsDto,
  type EntityDossierDto,
  type EntityNeighborhoodResponse,
  type EntityConnectResponse,
  type EntityType,
  type RelationType,
  commitmentSchema,
  commitmentListResponseSchema,
  itemCommitmentsResponseSchema,
  type CommitmentDto,
  type CommitmentDirection,
  type CommitmentListResponse,
  type CommitmentStatus,
  type ItemCommitmentsResponse,
  type UpdateCommitmentStatusRequest,
  questionSchema,
  questionListResponseSchema,
  itemQuestionsResponseSchema,
  type QuestionDto,
  type QuestionDirection,
  type QuestionListResponse,
  type QuestionStatus,
  type ItemQuestionsResponse,
  type UpdateQuestionStatusRequest,
  openLoopSchema,
  openLoopListResponseSchema,
  type OpenLoopDto,
  type OpenLoopKind,
  type OpenLoopListResponse,
  type OpenLoopState,
  nudgeListResponseSchema,
  type NudgeListResponse,
  type NudgeActionRequest,
  reminderSchema,
  reminderListResponseSchema,
  itemRemindersResponseSchema,
  type ReminderDto,
  type ReminderListResponse,
  type ReminderStatus,
  type ItemRemindersResponse,
  documentListResponseSchema,
  itemDocMetaResponseSchema,
  itemOcrResponseSchema,
  type DocumentListResponse,
  type DocumentType,
  type ItemDocMetaResponse,
  type ItemOcrResponse,
  type UpdateEntityRequest,
  searchResponseSchema,
  similarResponseSchema,
  type SearchRequest,
  type SearchResponse,
  type SimilarResponse,
  chatAskResponseSchema,
  chatConversationDetailSchema,
  chatConversationListResponseSchema,
  chatStatusSchema,
  type ChatAskRequest,
  type ChatAskResponse,
  type ChatConversationDetailDto,
  type ChatConversationListResponse,
  type ChatStatusDto,
  aiProviderSchema,
  aiProviderListSchema,
  aiCapabilitiesResponseSchema,
  aiCapabilitySettingSchema,
  type AiProviderDto,
  type AiProviderListDto,
  type AiCapabilitiesResponseDto,
  type AiCapabilitySettingDto,
  type AiCapability,
  type CreateAiProviderRequest,
  type UpdateAiProviderRequest,
  type UpdateAiCapabilityRequest,
  auditLogListResponseSchema,
  panicDeleteResponseSchema,
  deadMansSwitchSchema,
  type AuditLogListResponse,
  type PanicDeleteResponse,
  type DeadMansSwitchDto,
  type UpdateDeadMansSwitchRequest,
} from '@plaudern/contracts';

/**
 * Thin typed client for the plaudern API. All URLs are relative: the Vite dev
 * server and the production nginx both proxy `/api` to the backend, so the
 * SPA never deals with CORS (presigned MinIO PUTs are the one cross-origin
 * call, covered by MinIO's own CORS config).
 */
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when any API call comes back 401 — the session ended server-side. */
export const UNAUTHORIZED_EVENT = 'plaudern:unauthorized';

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await request(path, init);
  return res.json();
}

/** For endpoints that reply 204 No Content — `res.json()` would throw there. */
export async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  await request(path, init);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    // Auth endpoints handle their own 401s (e.g. the initial "who am I?"
    // probe); everywhere else a 401 means the session died — tell the app.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body}`);
  }
  return res;
}

export async function listInbox(limit = 20, cursor?: string): Promise<InboxListResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return inboxListResponseSchema.parse(await requestJson(`/inbox?${query}`));
}

export async function getItem(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(await requestJson(`/inbox/${id}`));
}

export async function getSourceUrl(id: string): Promise<string | null> {
  const body = (await requestJson(`/inbox/${id}/source-url`)) as { url: string | null };
  return body.url;
}

/** Permanently delete an inbox item, its extractions and its stored blobs. */
export async function deleteInboxItem(id: string): Promise<void> {
  return requestVoid(`/inbox/${id}`, { method: 'DELETE' });
}

/**
 * Combine several recordings into one. The originals are hidden (not
 * deleted) behind the merged recording and come back on split.
 */
export async function mergeItems(itemIds: string[]): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson('/inbox/merge', { method: 'POST', body: JSON.stringify({ itemIds }) }),
  );
}

/** Undo a merge: delete the merged recording and restore the originals. */
export async function splitItem(id: string): Promise<InboxSplitResponse> {
  return inboxSplitResponseSchema.parse(
    await requestJson(`/inbox/${id}/split`, { method: 'POST' }),
  );
}

/**
 * DANGER: purge every recording and all recording-derived data for the current
 * user, clearing idempotency tombstones so a Plaud re-sync reloads them fresh.
 */
export async function purgeAllData(): Promise<InboxPurgeResponse> {
  return inboxPurgeResponseSchema.parse(await requestJson('/inbox', { method: 'DELETE' }));
}

/**
 * Re-run the whole processing pipeline (transcription + speaker diarization)
 * for a recording; returns the refreshed item.
 */
export async function reprocessItem(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/ingest/${id}/reprocess`, { method: 'POST' }),
  );
}

/** Re-run transcription only; the summary follows automatically. */
export async function retryTranscription(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/transcription/retry`, { method: 'POST' }),
  );
}

/** Re-run speaker identification (diarization) only; the summary follows. */
export async function retryDiarization(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/diarization/retry`, { method: 'POST' }),
  );
}

/** Re-generate semantic embeddings only; returns the refreshed item. */
export async function retryEmbeddings(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/embeddings/retry`, { method: 'POST' }),
  );
}

/** Re-run entity extraction only; relations re-run automatically afterwards. */
export async function retryEntities(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/entities/retry`, { method: 'POST' }),
  );
}

/** Re-run relation extraction only (needs a completed entity extraction). */
export async function retryRelations(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/relations/retry`, { method: 'POST' }),
  );
}

/** Reverse-geocode coordinates to a place (label/city null when unavailable). */
export async function getPlaceName(lat: number, lon: number): Promise<GeocodeResponse> {
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  return geocodeResponseSchema.parse(await requestJson(`/geocode?${query}`));
}

export async function ingestInit(req: IngestInitRequest): Promise<IngestInitResponse> {
  return ingestInitResponseSchema.parse(
    await requestJson('/ingest/init', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function ingestCommit(inboxItemId: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/ingest/${inboxItemId}/commit`, { method: 'POST' }),
  );
}

/** Save an inline text note as an immediately-committed inbox item. */
export async function ingestText(req: IngestTextRequest): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson('/ingest/text', { method: 'POST', body: JSON.stringify(req) }),
  );
}

/**
 * Save a web clip (`sources/web`): a shared URL plus optional title/text.
 * The server fetches a readable-text snapshot of the page when no text is
 * provided and gracefully falls back to storing just the URL.
 */
export async function ingestWeb(req: IngestWebRequest): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson('/ingest/web', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function getPlaudSettings(): Promise<PlaudSettingsDto> {
  return plaudSettingsSchema.parse(await requestJson('/settings/plaud'));
}

export async function updatePlaudSettings(
  req: UpdatePlaudSettingsRequest,
): Promise<PlaudSettingsDto> {
  return plaudSettingsSchema.parse(
    await requestJson('/settings/plaud', { method: 'PUT', body: JSON.stringify(req) }),
  );
}

export async function testPlaudConnection(
  req: PlaudTestConnectionRequest,
): Promise<PlaudTestConnectionResponse> {
  return plaudTestConnectionResponseSchema.parse(
    await requestJson('/settings/plaud/test', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function triggerPlaudSync(): Promise<PlaudSyncNowResponse> {
  return plaudSyncNowResponseSchema.parse(
    await requestJson('/settings/plaud/sync', { method: 'POST' }),
  );
}

export async function getEmailSettings(): Promise<EmailSettingsDto> {
  return emailSettingsSchema.parse(await requestJson('/settings/email'));
}

export async function updateEmailSettings(
  req: UpdateEmailSettingsRequest,
): Promise<EmailSettingsDto> {
  return emailSettingsSchema.parse(
    await requestJson('/settings/email', { method: 'PUT', body: JSON.stringify(req) }),
  );
}

/** Generates the address on first call, rotates (invalidating the old one) after. */
export async function rotateEmailToken(): Promise<EmailSettingsDto> {
  return emailSettingsSchema.parse(await requestJson('/settings/email/rotate', { method: 'POST' }));
}

export async function getMcpTokenStatus(): Promise<McpTokenStatusDto> {
  return mcpTokenStatusSchema.parse(await requestJson('/settings/mcp'));
}

/** Mints the token on first call, rotates it (invalidating the old one) after. The plaintext is returned only here. */
export async function mintMcpToken(): Promise<McpTokenCreatedDto> {
  return mcpTokenCreatedSchema.parse(
    await requestJson('/settings/mcp/token', { method: 'POST' }),
  );
}

export async function revokeMcpToken(): Promise<void> {
  return requestVoid('/settings/mcp/token', { method: 'DELETE' });
}

export async function getSpeakerTranscript(itemId: string): Promise<SpeakerTranscriptDto> {
  return speakerTranscriptSchema.parse(await requestJson(`/inbox/${itemId}/speaker-transcript`));
}

/** AI-generated title + Markdown summary (and speaker roster for mentions). */
export async function getSummary(itemId: string): Promise<SummaryDto> {
  return summarySchema.parse(await requestJson(`/inbox/${itemId}/summary`));
}

/** Manually (re)generate the summary; returns the refreshed (in-flight) summary. */
export async function retrySummary(itemId: string): Promise<SummaryDto> {
  return summarySchema.parse(
    await requestJson(`/inbox/${itemId}/summary/retry`, { method: 'POST' }),
  );
}

/** The item's sensitivity classification (tier, mask spans, held state) — JJ-21. */
export async function getItemSensitivity(itemId: string) {
  return itemSensitivitySchema.parse(await requestJson(`/inbox/${itemId}/sensitivity`));
}

/** Set (or clear, with null) a user's manual sensitivity-tier override — JJ-21. */
export async function setItemSensitivity(
  itemId: string,
  manualTier: 'public' | 'normal' | 'sensitive' | 'secret' | null,
) {
  return itemSensitivitySchema.parse(
    await requestJson(`/inbox/${itemId}/sensitivity`, {
      method: 'PATCH',
      body: JSON.stringify({ manualTier }),
    }),
  );
}

export async function getSummarizationSettings(): Promise<SummarizationSettingsDto> {
  return summarizationSettingsSchema.parse(await requestJson('/settings/summarization'));
}

export async function updateSummarizationSettings(
  req: UpdateSummarizationSettingsRequest,
): Promise<SummarizationSettingsDto> {
  return summarizationSettingsSchema.parse(
    await requestJson('/settings/summarization', { method: 'PUT', body: JSON.stringify(req) }),
  );
}

export async function getConsentSettings(): Promise<ConsentSettingsDto> {
  return consentSettingsSchema.parse(await requestJson('/settings/consent'));
}

export async function updateConsentSettings(
  req: UpdateConsentSettingsRequest,
): Promise<ConsentSettingsDto> {
  return consentSettingsSchema.parse(
    await requestJson('/settings/consent', { method: 'PUT', body: JSON.stringify(req) }),
  );
}

export async function getNotificationPreferences(): Promise<NotificationPreferencesDto> {
  return notificationPreferencesSchema.parse(await requestJson('/notifications/preferences'));
}

export async function updateNotificationPreferences(
  req: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferencesDto> {
  return notificationPreferencesSchema.parse(
    await requestJson('/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify(req),
    }),
  );
}

export async function getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  return vapidPublicKeyResponseSchema.parse(await requestJson('/notifications/push/public-key'));
}

export async function registerPushSubscription(
  req: RegisterPushSubscriptionRequest,
): Promise<void> {
  await requestVoid('/notifications/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await requestVoid('/notifications/push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  });
}

export async function sendTestNotification(
  req: SendTestNotificationRequest,
): Promise<NotificationDispatchResult> {
  return notificationDispatchResultSchema.parse(
    await requestJson('/notifications/test', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function listSpeakers(): Promise<VoiceProfileListResponse> {
  return voiceProfileListResponseSchema.parse(await requestJson('/speakers'));
}

export async function getSpeaker(id: string): Promise<VoiceProfileDetailDto> {
  return voiceProfileDetailSchema.parse(await requestJson(`/speakers/${id}`));
}

export async function updateSpeaker(
  id: string,
  req: UpdateVoiceProfileRequest,
): Promise<VoiceProfileDetailDto> {
  return voiceProfileDetailSchema.parse(
    await requestJson(`/speakers/${id}`, { method: 'PATCH', body: JSON.stringify(req) }),
  );
}

export async function mergeSpeakers(
  targetId: string,
  sourceProfileId: string,
): Promise<VoiceProfileDetailDto> {
  return voiceProfileDetailSchema.parse(
    await requestJson(`/speakers/${targetId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ sourceProfileId }),
    }),
  );
}

/**
 * The per-user entity registry / knowledge graph. Unreferenced ghost rows are
 * hidden by default (the API's own default); pass `includeUnreferenced` to show
 * entities no current extraction mentions any more.
 */
export async function listEntities(
  type?: EntityType,
  includeUnreferenced = false,
): Promise<EntityListResponse> {
  const query = new URLSearchParams();
  if (type) query.set('type', type);
  if (includeUnreferenced) query.set('includeUnreferenced', 'true');
  const suffix = query.toString() ? `?${query}` : '';
  return entityListResponseSchema.parse(await requestJson(`/entities${suffix}`));
}

/** One registry entity with its mentions (recordings) and aggregated relation edges. */
export async function getEntity(id: string): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(await requestJson(`/entities/${id}`));
}

/**
 * The person dossier (JJ-24): everything the platform knows about one entity —
 * facts (active + superseded), commitments both ways, open questions, relations
 * and recent mentions — each cited to its source recording.
 */
export async function getEntityDossier(id: string): Promise<EntityDossierDto> {
  return entityDossierSchema.parse(await requestJson(`/entities/${id}/dossier`));
}

/** Correct a registry entity: rename it and/or change its type. */
export async function updateEntity(
  id: string,
  req: UpdateEntityRequest,
): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(
    await requestJson(`/entities/${id}`, { method: 'PATCH', body: JSON.stringify(req) }),
  );
}

/**
 * Ranked contact candidates for a person entity, straight from the identity
 * resolver: confidence plus human-readable evidence (name affinity, whose
 * voice is in the recordings, shared knowledge-graph connections).
 */
export async function getEntityContactSuggestions(
  id: string,
): Promise<EntityContactSuggestionsResponse> {
  return entityContactSuggestionsResponseSchema.parse(
    await requestJson(`/entities/${id}/contact-suggestions`),
  );
}

/** Manually link a person entity to a contact-book voice profile. */
export async function linkEntityContact(
  id: string,
  voiceProfileId: string,
): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(
    await requestJson(`/entities/${id}/contact-link`, {
      method: 'PUT',
      body: JSON.stringify({ voiceProfileId }),
    }),
  );
}

/** Unlink an entity from the contact book; auto-linking won't re-link it. */
export async function unlinkEntityContact(id: string): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(
    await requestJson(`/entities/${id}/contact-link`, { method: 'DELETE' }),
  );
}

/** Promote a person entity to a new confirmed contact and link it. */
export async function convertEntityToContact(id: string): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(
    await requestJson(`/entities/${id}/convert-to-contact`, { method: 'POST' }),
  );
}

/**
 * Re-run contact auto-linking over every unlinked person entity — e.g. after
 * naming a speaker in the contact book. Returns how many entities linked up.
 */
export async function autoLinkEntities(): Promise<AutoLinkEntitiesResponse> {
  return autoLinkEntitiesResponseSchema.parse(
    await requestJson('/entities/auto-link', { method: 'POST' }),
  );
}

/** One hop of the graph around an entity: its edges plus the connected entities. */
export async function getEntityNeighborhood(
  id: string,
  relationType?: RelationType,
): Promise<EntityNeighborhoodResponse> {
  const query = new URLSearchParams();
  if (relationType) query.set('relationType', relationType);
  const suffix = query.toString() ? `?${query}` : '';
  return entityNeighborhoodResponseSchema.parse(
    await requestJson(`/entities/${id}/neighborhood${suffix}`),
  );
}

/**
 * The subgraph connecting 2–3 entities: shortest paths from the first id to
 * each of the others. Pass `includeCooccurrence=false` to traverse only
 * LLM-evidenced edges.
 *
 * Not called by any page yet — this is the client for the upcoming graph-view
 * feature.
 */
export async function connectEntities(
  ids: string[],
  opts?: { maxDepth?: number; includeCooccurrence?: boolean },
): Promise<EntityConnectResponse> {
  const query = new URLSearchParams({ ids: ids.join(',') });
  if (opts?.maxDepth !== undefined) query.set('maxDepth', String(opts.maxDepth));
  if (opts?.includeCooccurrence === false) query.set('includeCooccurrence', 'false');
  return entityConnectResponseSchema.parse(await requestJson(`/entities/graph/connect?${query}`));
}

/**
 * Merge & suppress tooling (JJ-63). Each mutation returns the refreshed entity
 * detail (mentions + relations), so the detail page reloads from one call.
 * Durability against re-extraction is enforced server-side.
 */

/** Merge `victimId` INTO `survivorId` (the survivor is kept). */
export async function mergeEntities(
  survivorId: string,
  victimId: string,
): Promise<EntityDetailWithRelationsDto> {
  return entityDetailWithRelationsSchema.parse(
    await requestJson(`/entities/${survivorId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ victimId }),
    }),
  );
}

/**
 * Likely-duplicate entities for this one — an entity with the same name under a
 * different type, plus (with `fuzzy`) similar names worth confirming. Read-only;
 * apply via `mergeEntities`.
 */
export async function duplicateCandidates(
  id: string,
  fuzzy = false,
): Promise<DuplicateCandidatesResponse> {
  const suffix = fuzzy ? '?fuzzy=true' : '';
  return duplicateCandidatesResponseSchema.parse(
    await requestJson(`/entities/${id}/duplicate-candidates${suffix}`),
  );
}

/**
 * Recorded merge suggestions (default: pending) — likely-duplicate pairs
 * detected automatically after extraction.
 */
export async function listMergeSuggestions(
  status?: MergeSuggestionStatus,
): Promise<MergeSuggestionsResponse> {
  const suffix = status ? `?status=${status}` : '';
  return mergeSuggestionsResponseSchema.parse(await requestJson(`/entities/suggestions${suffix}`));
}

/** Dismiss a merge suggestion so it is not surfaced again. */
export async function dismissMergeSuggestion(id: string): Promise<void> {
  await requestVoid(`/entities/suggestions/${id}/dismiss`, { method: 'POST' });
}

/**
 * Ask the LLM judge whether `id` and `candidateId` are the same real-world
 * thing (and which type/survivor to keep). Pass `web` to also consult opt-in web
 * research. `recommendation` is null when no judge is configured.
 */
export async function reconcileEntity(
  id: string,
  candidateId: string,
  web = false,
): Promise<ReconcileResponse> {
  return reconcileResponseSchema.parse(
    await requestJson(`/entities/${id}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ candidateId, web }),
    }),
  );
}

/** Delete/suppress an entity so re-extraction cannot recreate it. */
export async function deleteEntity(id: string): Promise<void> {
  await requestVoid(`/entities/${id}`, { method: 'DELETE' });
}

export async function listCalendarFeeds(): Promise<CalendarFeedsResponse> {
  return calendarFeedsResponseSchema.parse(await requestJson('/calendar/feeds'));
}

export async function createCalendarFeed(req: CreateCalendarFeedRequest): Promise<CalendarFeedDto> {
  return calendarFeedSchema.parse(
    await requestJson('/calendar/feeds', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function updateCalendarFeed(
  id: string,
  req: UpdateCalendarFeedRequest,
): Promise<CalendarFeedDto> {
  return calendarFeedSchema.parse(
    await requestJson(`/calendar/feeds/${id}`, { method: 'PUT', body: JSON.stringify(req) }),
  );
}

export async function deleteCalendarFeed(id: string): Promise<void> {
  const res = await fetch(`${BASE}/calendar/feeds/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, `DELETE /calendar/feeds/${id} failed (${res.status})`);
}

export async function testCalendarFeed(url: string): Promise<CalendarFeedTestResponse> {
  return calendarFeedTestResponseSchema.parse(
    await requestJson('/calendar/feeds/test', { method: 'POST', body: JSON.stringify({ url }) }),
  );
}

export async function triggerCalendarSync(): Promise<CalendarSyncNowResponse> {
  return calendarSyncNowResponseSchema.parse(
    await requestJson('/calendar/sync', { method: 'POST' }),
  );
}

export async function listCalendarEvents(from: string, to: string): Promise<CalendarEventsResponse> {
  const query = new URLSearchParams({ from, to });
  return calendarEventsResponseSchema.parse(await requestJson(`/calendar/events?${query}`));
}

export async function getCalendarEvent(id: string): Promise<CalendarEventDetailDto> {
  return calendarEventDetailSchema.parse(await requestJson(`/calendar/events/${id}`));
}

export async function listCalendarRecordings(
  from: string,
  to: string,
): Promise<CalendarRecordingsResponse> {
  const query = new URLSearchParams({ from, to });
  return calendarRecordingsResponseSchema.parse(await requestJson(`/calendar/recordings?${query}`));
}

export async function listItemEvents(inboxItemId: string): Promise<ItemEventsResponse> {
  return itemEventsResponseSchema.parse(await requestJson(`/calendar/items/${inboxItemId}/events`));
}

export async function createCalendarLink(
  inboxItemId: string,
  eventId: string,
): Promise<LinkResponse> {
  return linkResponseSchema.parse(
    await requestJson('/calendar/links', {
      method: 'POST',
      body: JSON.stringify({ inboxItemId, eventId }),
    }),
  );
}

export async function deleteCalendarLink(inboxItemId: string, eventId: string): Promise<void> {
  const res = await fetch(`${BASE}/calendar/links/${inboxItemId}/${eventId}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, `DELETE /calendar/links failed (${res.status})`);
}

export async function getGoogleAuthUrl(): Promise<GoogleAuthUrlResponse> {
  return googleAuthUrlResponseSchema.parse(await requestJson('/calendar/google/auth-url'));
}

export async function getGooglePending(id: string): Promise<GooglePendingResponse> {
  return googlePendingResponseSchema.parse(await requestJson(`/calendar/google/pending/${id}`));
}

export async function createGoogleFeeds(
  pendingId: string,
  calendarIds: string[],
): Promise<CalendarFeedDto[]> {
  return z
    .array(calendarFeedSchema)
    .parse(
      await requestJson('/calendar/google/feeds', {
        method: 'POST',
        body: JSON.stringify({ pendingId, calendarIds }),
      }),
    );
}

export async function reconnectGoogle(pendingId: string): Promise<{ updated: number }> {
  return (await requestJson('/calendar/google/reconnect', {
    method: 'POST',
    body: JSON.stringify({ pendingId }),
  })) as { updated: number };
}

/** The editable topic/project taxonomy items are classified against. */
export async function listTopics(): Promise<TopicListResponse> {
  return topicListResponseSchema.parse(await requestJson('/topics'));
}

export async function createTopic(req: CreateTopicRequest): Promise<TopicDto> {
  return topicSchema.parse(
    await requestJson('/topics', { method: 'POST', body: JSON.stringify(req) }),
  );
}

/** Partial update: rename, edit the description, or (un)archive a topic. */
export async function updateTopic(id: string, req: UpdateTopicRequest): Promise<TopicDto> {
  return topicSchema.parse(
    await requestJson(`/topics/${id}`, { method: 'PATCH', body: JSON.stringify(req) }),
  );
}

/** Delete a topic; its assignments on already-classified items are removed too. */
export async function deleteTopic(id: string): Promise<void> {
  return requestVoid(`/topics/${id}`, { method: 'DELETE' });
}

/** The inbox items classified under a topic, newest occurrence first. */
export async function listTopicItems(id: string): Promise<TopicItemsResponse> {
  return topicItemsResponseSchema.parse(await requestJson(`/topics/${id}/items`));
}

/** An item's topic assignments plus the classification pipeline status. */
export async function getItemTopics(itemId: string): Promise<ItemTopicsResponse> {
  return itemTopicsResponseSchema.parse(await requestJson(`/inbox/${itemId}/topics`));
}

/** Re-run zero-shot topic classification for an item; returns the refreshed read model. */
export async function retryItemTopics(itemId: string): Promise<ItemTopicsResponse> {
  return itemTopicsResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/topics/retry`, { method: 'POST' }),
  );
}

/** Taxonomy proposals from embedding clusters (JJ-64), plus whether the feature is enabled. */
export async function listTopicProposals(): Promise<TopicProposalListResponse> {
  return topicProposalListResponseSchema.parse(await requestJson('/topics/proposals'));
}

/** Trigger a fresh clustering + labeling pass; returns the refreshed proposal list. */
export async function generateTopicProposals(): Promise<TopicProposalListResponse> {
  return topicProposalListResponseSchema.parse(
    await requestJson('/topics/proposals/generate', { method: 'POST' }),
  );
}

/** Accept a proposal: creates the topic and reclassifies the cluster's items. */
export async function acceptTopicProposal(id: string): Promise<TopicDto> {
  return topicSchema.parse(
    await requestJson(`/topics/proposals/${id}/accept`, { method: 'POST' }),
  );
}

/** Dismiss a proposal so its cluster is not proposed again. */
export async function dismissTopicProposal(id: string): Promise<void> {
  return requestVoid(`/topics/proposals/${id}/dismiss`, { method: 'POST' });
}

// ---- Living topic documents (JJ-12) ----

/** The topic's evergreen, self-updating cited document (current version). */
export async function getTopicDocument(topicId: string): Promise<TopicDocumentResponse> {
  return topicDocumentResponseSchema.parse(await requestJson(`/topics/${topicId}/document`));
}

/** Metadata for every saved version of the document, newest first. */
export async function listTopicDocumentVersions(
  topicId: string,
): Promise<TopicDocumentVersionListResponse> {
  return topicDocumentVersionListResponseSchema.parse(
    await requestJson(`/topics/${topicId}/document/versions`),
  );
}

/** One historical version rendered in full. */
export async function getTopicDocumentVersion(
  topicId: string,
  version: number,
): Promise<TopicDocumentVersionDetailDto> {
  return topicDocumentVersionDetailSchema.parse(
    await requestJson(`/topics/${topicId}/document/versions/${version}`),
  );
}

/** Manually (re)generate the document; returns the refreshed read model. */
export async function regenerateTopicDocument(topicId: string): Promise<TopicDocumentResponse> {
  return topicDocumentResponseSchema.parse(
    await requestJson(`/topics/${topicId}/document/regenerate`, { method: 'POST' }),
  );
}

// ---- Auto-journal (JJ-17) ----

/** Every composed entry of a granularity (day/week/month/year), newest first. */
export async function listJournalPeriods(
  periodType: JournalPeriodType,
): Promise<JournalPeriodListResponse> {
  return journalPeriodListResponseSchema.parse(await requestJson(`/journal/${periodType}`));
}

/** One period's current entry (body + latest-attempt status). */
export async function getJournal(
  periodType: JournalPeriodType,
  periodKey: string,
): Promise<JournalDocumentResponse> {
  return journalDocumentResponseSchema.parse(
    await requestJson(`/journal/${periodType}/${periodKey}`),
  );
}

/** A period's succeeded version history (metadata only). */
export async function listJournalVersions(
  periodType: JournalPeriodType,
  periodKey: string,
): Promise<JournalVersionListResponse> {
  return journalVersionListResponseSchema.parse(
    await requestJson(`/journal/${periodType}/${periodKey}/versions`),
  );
}

/** One historical version rendered in full. */
export async function getJournalVersion(
  periodType: JournalPeriodType,
  periodKey: string,
  version: number,
): Promise<JournalVersionDetailDto> {
  return journalVersionDetailSchema.parse(
    await requestJson(`/journal/${periodType}/${periodKey}/versions/${version}`),
  );
}

/** Manually (re)compose the period; returns the refreshed read model. */
export async function regenerateJournal(
  periodType: JournalPeriodType,
  periodKey: string,
): Promise<JournalDocumentResponse> {
  return journalDocumentResponseSchema.parse(
    await requestJson(`/journal/${periodType}/${periodKey}/regenerate`, { method: 'POST' }),
  );
}

/** An item's extracted commitments plus the extraction pipeline status. */
export async function getItemCommitments(itemId: string): Promise<ItemCommitmentsResponse> {
  return itemCommitmentsResponseSchema.parse(await requestJson(`/inbox/${itemId}/commitments`));
}

/** Re-run commitment extraction for an item; returns the refreshed read model. */
export async function retryItemCommitments(itemId: string): Promise<ItemCommitmentsResponse> {
  return itemCommitmentsResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/commitments/retry`, { method: 'POST' }),
  );
}

/** The user's commitments across all recordings, optionally filtered. */
export async function listCommitments(filters?: {
  direction?: CommitmentDirection;
  status?: CommitmentStatus;
}): Promise<CommitmentListResponse> {
  const query = new URLSearchParams();
  if (filters?.direction) query.set('direction', filters.direction);
  if (filters?.status) query.set('status', filters.status);
  const suffix = query.toString() ? `?${query}` : '';
  return commitmentListResponseSchema.parse(await requestJson(`/commitments${suffix}`));
}

/** Advance a commitment's lifecycle status (open → fulfilled / dismissed). */
export async function updateCommitmentStatus(
  id: string,
  req: UpdateCommitmentStatusRequest,
): Promise<CommitmentDto> {
  return commitmentSchema.parse(
    await requestJson(`/commitments/${id}`, { method: 'PATCH', body: JSON.stringify(req) }),
  );
}

/** An item's extracted open questions plus the extraction pipeline status. */
export async function getItemQuestions(itemId: string): Promise<ItemQuestionsResponse> {
  return itemQuestionsResponseSchema.parse(await requestJson(`/inbox/${itemId}/questions`));
}

/** Re-run question extraction for an item; returns the refreshed read model. */
export async function retryItemQuestions(itemId: string): Promise<ItemQuestionsResponse> {
  return itemQuestionsResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/questions/retry`, { method: 'POST' }),
  );
}

/** The user's open questions across all recordings, optionally filtered. */
export async function listQuestions(filters?: {
  direction?: QuestionDirection;
  status?: QuestionStatus;
}): Promise<QuestionListResponse> {
  const query = new URLSearchParams();
  if (filters?.direction) query.set('direction', filters.direction);
  if (filters?.status) query.set('status', filters.status);
  const suffix = query.toString() ? `?${query}` : '';
  return questionListResponseSchema.parse(await requestJson(`/questions${suffix}`));
}

/** Advance a question's lifecycle status (open → answered / dropped). */
export async function updateQuestionStatus(
  id: string,
  req: UpdateQuestionStatusRequest,
): Promise<QuestionDto> {
  return questionSchema.parse(
    await requestJson(`/questions/${id}`, { method: 'PATCH', body: JSON.stringify(req) }),
  );
}

/** The user's deduplicated tasks (JJ-35), optionally filtered by status. */
export async function listTasks(status?: TaskStatus): Promise<TaskListResponse> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
  return taskListResponseSchema.parse(await requestJson(`/tasks${suffix}`));
}

/** Change a task's lifecycle status (complete / dismiss / reopen). */
export async function updateTaskStatus(id: string, status: TaskStatus): Promise<TaskDto> {
  return taskSchema.parse(
    await requestJson(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  );
}

/** An item's extracted tasks plus the extraction pipeline status. */
export async function getItemTasks(itemId: string): Promise<ItemTasksResponse> {
  return itemTasksResponseSchema.parse(await requestJson(`/inbox/${itemId}/tasks`));
}

/** Re-run task extraction for an item; returns the refreshed read model. */
export async function retryItemTasks(itemId: string): Promise<ItemTasksResponse> {
  return itemTasksResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/tasks/retry`, { method: 'POST' }),
  );
}

// ---- Prospective-memory reminders (JJ-25) ----

/**
 * The user's calendar-visible reminders, optionally scoped to a due window
 * ([from, to] ISO) and/or a status. The calendar fetches just the visible
 * range; an "active" filter yields everything still pending.
 */
export async function listReminders(filters?: {
  from?: string;
  to?: string;
  status?: ReminderStatus;
}): Promise<ReminderListResponse> {
  const query = new URLSearchParams();
  if (filters?.from) query.set('from', filters.from);
  if (filters?.to) query.set('to', filters.to);
  if (filters?.status) query.set('status', filters.status);
  const suffix = query.toString() ? `?${query}` : '';
  return reminderListResponseSchema.parse(await requestJson(`/reminders${suffix}`));
}

/** Advance a reminder's lifecycle status (active → done / dismissed, or reopen). */
export async function updateReminderStatus(
  id: string,
  status: ReminderStatus,
): Promise<ReminderDto> {
  return reminderSchema.parse(
    await requestJson(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  );
}

/** An item's extracted reminders plus the extraction pipeline status. */
export async function getItemReminders(itemId: string): Promise<ItemRemindersResponse> {
  return itemRemindersResponseSchema.parse(await requestJson(`/inbox/${itemId}/reminders`));
}

/** Re-run reminder extraction for an item; returns the refreshed read model. */
export async function retryItemReminders(itemId: string): Promise<ItemRemindersResponse> {
  return itemRemindersResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/reminders/retry`, { method: 'POST' }),
  );
}

// ---- Document vault: photo/scan OCR + docmeta (JJ-30 / JJ-16) ----

/**
 * The user's document vault: every scanned/uploaded document, newest first,
 * optionally scoped to a single document type. The vault page groups them by
 * type client-side and surfaces expiry / Kündigungsfrist dates.
 */
export async function listVaultDocuments(
  documentType?: DocumentType,
): Promise<DocumentListResponse> {
  const suffix = documentType ? `?documentType=${encodeURIComponent(documentType)}` : '';
  return documentListResponseSchema.parse(await requestJson(`/documents${suffix}`));
}

/** An item's structured document metadata plus the extraction pipeline status. */
export async function getItemDocMeta(itemId: string): Promise<ItemDocMetaResponse> {
  return itemDocMetaResponseSchema.parse(await requestJson(`/inbox/${itemId}/docmeta`));
}

/** Re-run document-metadata extraction for an item; returns the refreshed read model. */
export async function retryItemDocMeta(itemId: string): Promise<ItemDocMetaResponse> {
  return itemDocMetaResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/docmeta/retry`, { method: 'POST' }),
  );
}

/** An item's recognized OCR text plus the extraction pipeline status. */
export async function getItemOcr(itemId: string): Promise<ItemOcrResponse> {
  return itemOcrResponseSchema.parse(await requestJson(`/inbox/${itemId}/ocr`));
}

/** Re-run OCR for an item; returns the refreshed read model. */
export async function retryItemOcr(itemId: string): Promise<ItemOcrResponse> {
  return itemOcrResponseSchema.parse(
    await requestJson(`/inbox/${itemId}/ocr/retry`, { method: 'POST' }),
  );
}

// ---- Open-loop ledger (JJ-29) ----

/**
 * The unified open-loop ledger: every unresolved thread (open tasks + open
 * commitments both ways, later questions), ranked by age + importance.
 * `includeResolved` brings done/dropped rows back for the archive toggle.
 */
export async function listOpenLoops(filters?: {
  kind?: OpenLoopKind;
  direction?: CommitmentDirection;
  includeResolved?: boolean;
}): Promise<OpenLoopListResponse> {
  const query = new URLSearchParams();
  if (filters?.kind) query.set('kind', filters.kind);
  if (filters?.direction) query.set('direction', filters.direction);
  if (filters?.includeResolved) query.set('includeResolved', 'true');
  const suffix = query.toString() ? `?${query}` : '';
  return openLoopListResponseSchema.parse(await requestJson(`/open-loops${suffix}`));
}

/** Advance an open loop (done / dropped / reopen); routed to its owning source. */
export async function updateOpenLoopState(
  kind: OpenLoopKind,
  id: string,
  state: OpenLoopState,
): Promise<OpenLoopDto> {
  return openLoopSchema.parse(
    await requestJson(`/open-loops/${kind}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    }),
  );
}

/** The user's active commitment nudges (JJ-26), for the ledger surface. */
export async function listNudges(): Promise<NudgeListResponse> {
  return nudgeListResponseSchema.parse(await requestJson('/nudges'));
}

/** Dismiss or snooze a nudge; keyed by the underlying commitment id. */
export async function actOnNudge(commitmentId: string, req: NudgeActionRequest): Promise<void> {
  await requestVoid(`/nudges/${commitmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(req),
  });
}

/**
 * Direct browser PUT to the presigned URL. XHR instead of fetch because fetch
 * has no upload progress. The Content-Type MUST be exactly the value passed
 * to `init` — it is part of the presigned signature.
 */
export function uploadToPresignedUrl(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('upload failed (network error)'));
    xhr.send(blob);
  });
}

// ---- Hybrid search (JJ-38) ----

/**
 * Hybrid search over the whole memory: semantic (pgvector) + keyword (FTS) +
 * structured filters, fused with RRF. POST because the request carries a nested
 * filter object. `query` is optional when at least one filter is present.
 */
export async function searchMemory(req: SearchRequest): Promise<SearchResponse> {
  return searchResponseSchema.parse(
    await requestJson('/search', { method: 'POST', body: JSON.stringify(req) }),
  );
}

/** "More like this": items nearest an item's embedding centroid (vector only). */
export async function getSimilarItems(id: string, limit = 8): Promise<SimilarResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  return similarResponseSchema.parse(await requestJson(`/inbox/${id}/similar?${query}`));
}

// ---- Memory chat (JJ-37) ----

/** Whether memory chat can run (disabled until an LLM key is configured). */
export async function getChatStatus(): Promise<ChatStatusDto> {
  return chatStatusSchema.parse(await requestJson('/chat/status'));
}

/**
 * Ask the memory a question (optionally continuing a conversation). Every
 * assistant answer carries server-enforced citations that deep-link to the
 * source item and, when known, the audio timestamp.
 */
export async function askChat(req: ChatAskRequest): Promise<ChatAskResponse> {
  return chatAskResponseSchema.parse(
    await requestJson('/chat', { method: 'POST', body: JSON.stringify(req) }),
  );
}

export async function listChatConversations(): Promise<ChatConversationListResponse> {
  return chatConversationListResponseSchema.parse(await requestJson('/chat/conversations'));
}

export async function getChatConversation(id: string): Promise<ChatConversationDetailDto> {
  return chatConversationDetailSchema.parse(await requestJson(`/chat/conversations/${id}`));
}

export async function deleteChatConversation(id: string): Promise<void> {
  return requestVoid(`/chat/conversations/${id}`, { method: 'DELETE' });
}

// ---- Per-user AI configuration: provider connections + capability assignments ----

/** Every saved AI provider connection (credentials are write-only). */
export async function listAiProviders(): Promise<AiProviderListDto> {
  return aiProviderListSchema.parse(await requestJson('/settings/ai/providers'));
}

/** Save a new provider connection; omit/blank `apiKey` for keyless local endpoints. */
export async function createAiProvider(req: CreateAiProviderRequest): Promise<AiProviderDto> {
  return aiProviderSchema.parse(
    await requestJson('/settings/ai/providers', { method: 'POST', body: JSON.stringify(req) }),
  );
}

/** Partial update; omit `apiKey` to keep the stored key, '' to clear it. */
export async function updateAiProvider(
  id: string,
  req: UpdateAiProviderRequest,
): Promise<AiProviderDto> {
  return aiProviderSchema.parse(
    await requestJson(`/settings/ai/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(req),
    }),
  );
}

export async function deleteAiProvider(id: string): Promise<void> {
  return requestVoid(`/settings/ai/providers/${id}`, { method: 'DELETE' });
}

/** The capability catalog plus this user's per-capability provider assignments. */
export async function getAiCapabilities(): Promise<AiCapabilitiesResponseDto> {
  return aiCapabilitiesResponseSchema.parse(await requestJson('/settings/ai/capabilities'));
}

/** Assign/tune one capability (provider, model, timeout, enabled, params). */
export async function updateAiCapability(
  capability: AiCapability,
  req: UpdateAiCapabilityRequest,
): Promise<AiCapabilitySettingDto> {
  return aiCapabilitySettingSchema.parse(
    await requestJson(`/settings/ai/capabilities/${capability}`, {
      method: 'PUT',
      body: JSON.stringify(req),
    }),
  );
}

// ---- AI-provider audit log & data sovereignty (JJ-42) ----

/** One page of the user's audit log of external AI-provider calls, newest first. */
export async function fetchAuditLog(page = 1, pageSize = 50): Promise<AuditLogListResponse> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return auditLogListResponseSchema.parse(await requestJson(`/audit-log?${query}`));
}

/**
 * Download the whole archive (items + extractions + presigned assets + a
 * combined Markdown rendering) as one JSON file. Fetches the attachment and
 * triggers a browser save without navigating away.
 */
export async function downloadExport(): Promise<void> {
  const res = await request('/account/export');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `plaudern-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** DANGER: irreversibly wipe the signed-in user's archive. */
export async function panicDelete(confirm: string): Promise<PanicDeleteResponse> {
  return panicDeleteResponseSchema.parse(
    await requestJson('/account/panic-delete', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),
  );
}

export async function getDeadMansSwitch(): Promise<DeadMansSwitchDto> {
  return deadMansSwitchSchema.parse(await requestJson('/account/dead-mans-switch'));
}

export async function updateDeadMansSwitch(
  req: UpdateDeadMansSwitchRequest,
): Promise<DeadMansSwitchDto> {
  return deadMansSwitchSchema.parse(
    await requestJson('/account/dead-mans-switch', {
      method: 'PUT',
      body: JSON.stringify(req),
    }),
  );
}

export async function checkInDeadMansSwitch(): Promise<DeadMansSwitchDto> {
  return deadMansSwitchSchema.parse(
    await requestJson('/account/dead-mans-switch/check-in', { method: 'POST' }),
  );
}
