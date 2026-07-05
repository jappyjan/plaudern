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
  type CreateTopicRequest,
  type ItemTopicsResponse,
  type TopicDto,
  type TopicItemsResponse,
  type TopicListResponse,
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
  autoLinkEntitiesResponseSchema,
  entityContactSuggestionsResponseSchema,
  type AutoLinkEntitiesResponse,
  type EntityContactSuggestionsResponse,
  type EntityListResponse,
  type EntityDetailWithRelationsDto,
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
  type UpdateEntityRequest,
  searchResponseSchema,
  similarResponseSchema,
  type SearchRequest,
  type SearchResponse,
  type SimilarResponse,
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
