import {
  geocodeResponseSchema,
  inboxItemSchema,
  inboxListResponseSchema,
  ingestInitResponseSchema,
  plaudSettingsSchema,
  plaudSyncNowResponseSchema,
  plaudTestConnectionResponseSchema,
  type IngestInitRequest,
  type IngestInitResponse,
  type InboxItemDto,
  type InboxListResponse,
  type PlaudSettingsDto,
  type PlaudSyncNowResponse,
  type PlaudTestConnectionRequest,
  type PlaudTestConnectionResponse,
  type UpdatePlaudSettingsRequest,
} from '@plaudern/contracts';

/**
 * Thin typed client for the plaudern API. All URLs are relative: the Vite dev
 * server and the production nginx both proxy `/api` to the backend, so the
 * SPA never deals with CORS (presigned MinIO PUTs are the one cross-origin
 * call, covered by MinIO's own CORS config).
 */
const BASE = '/api/v1';

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
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

/** Enqueue a fresh transcription attempt; returns the refreshed item. */
export async function retryTranscription(id: string): Promise<InboxItemDto> {
  return inboxItemSchema.parse(
    await requestJson(`/inbox/${id}/transcription/retry`, { method: 'POST' }),
  );
}

/** Reverse-geocode coordinates to a place label (null when unavailable). */
export async function getPlaceName(lat: number, lon: number): Promise<string | null> {
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  return geocodeResponseSchema.parse(await requestJson(`/geocode?${query}`)).label;
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
