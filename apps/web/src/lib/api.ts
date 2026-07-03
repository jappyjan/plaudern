import {
  calendarEventDetailSchema,
  calendarEventsResponseSchema,
  calendarFeedSchema,
  calendarFeedsResponseSchema,
  calendarFeedTestResponseSchema,
  calendarRecordingsResponseSchema,
  calendarSyncNowResponseSchema,
  geocodeResponseSchema,
  inboxItemSchema,
  inboxListResponseSchema,
  inboxPurgeResponseSchema,
  ingestInitResponseSchema,
  itemEventsResponseSchema,
  linkResponseSchema,
  plaudSettingsSchema,
  plaudSyncNowResponseSchema,
  plaudTestConnectionResponseSchema,
  speakerTranscriptSchema,
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
  type GeocodeResponse,
  type IngestInitRequest,
  type IngestInitResponse,
  type InboxItemDto,
  type InboxListResponse,
  type InboxPurgeResponse,
  type PlaudSettingsDto,
  type PlaudSyncNowResponse,
  type PlaudTestConnectionRequest,
  type PlaudTestConnectionResponse,
  type ItemEventsResponse,
  type LinkResponse,
  type SpeakerTranscriptDto,
  type UpdateCalendarFeedRequest,
  type UpdatePlaudSettingsRequest,
  type UpdateVoiceProfileRequest,
  type VoiceProfileDetailDto,
  type VoiceProfileListResponse,
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

export async function getSpeakerTranscript(itemId: string): Promise<SpeakerTranscriptDto> {
  return speakerTranscriptSchema.parse(await requestJson(`/inbox/${itemId}/speaker-transcript`));
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
