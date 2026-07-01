import type {
  IngestInitRequest,
  IngestInitResponse,
  InboxItemDto,
  InboxListResponse,
} from '@plaudern/contracts';

export interface PlaudernClientConfig {
  baseUrl: string;
  /** Device API key sent as `x-device-key`. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Injected by the app: given a presigned URL and a local file, PUT the bytes.
 * On React Native this is backed by expo-file-system's uploadAsync; in tests a
 * simple fetch/PUT works. Decoupling this keeps the client env-agnostic (plan §4).
 */
export type UploadFn = (params: {
  uploadUrl: string;
  fileUri: string;
  contentType: string;
}) => Promise<void>;

/**
 * Typed client for the Inbox API. Shares DTOs with the backend via
 * @plaudern/contracts, so request/response shapes cannot drift (plan §1).
 */
export class PlaudernClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PlaudernClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-device-key': this.apiKey,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`plaudern API ${res.status} on ${path}: ${body}`);
    }
    return (await res.json()) as T;
  }

  initUpload(body: IngestInitRequest): Promise<IngestInitResponse> {
    return this.request<IngestInitResponse>('/api/v1/ingest/init', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  commit(inboxItemId: string): Promise<InboxItemDto> {
    return this.request<InboxItemDto>(`/api/v1/ingest/${inboxItemId}/commit`, {
      method: 'POST',
    });
  }

  listInbox(limit = 20, cursor?: string): Promise<InboxListResponse> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return this.request<InboxListResponse>(`/api/v1/inbox?${q.toString()}`);
  }

  getItem(id: string): Promise<InboxItemDto> {
    return this.request<InboxItemDto>(`/api/v1/inbox/${id}`);
  }

  getSourceUrl(id: string): Promise<{ url: string | null }> {
    return this.request<{ url: string | null }>(`/api/v1/inbox/${id}/source-url`);
  }

  /**
   * Full three-phase ingestion for a local audio file: init -> direct PUT ->
   * commit. `upload` is supplied by the app (expo-file-system on device).
   * Works for both the Plaud path and the dev/manual upload path (plan §4).
   */
  async uploadAudioFile(
    params: {
      fileUri: string;
      contentType: string;
      byteSize: number;
      occurredAt: string;
      idempotencyKey: string;
      sourceType?: IngestInitRequest['sourceType'];
      originalFilename?: string;
      metadata?: Record<string, unknown>;
    },
    upload: UploadFn,
  ): Promise<InboxItemDto> {
    const init = await this.initUpload({
      sourceType: params.sourceType ?? 'audio',
      contentType: params.contentType,
      byteSize: params.byteSize,
      occurredAt: params.occurredAt,
      idempotencyKey: params.idempotencyKey,
      originalFilename: params.originalFilename,
      metadata: params.metadata,
    });

    if (!init.alreadyCommitted) {
      await upload({
        uploadUrl: init.uploadUrl,
        fileUri: params.fileUri,
        contentType: params.contentType,
      });
    }

    return this.commit(init.inboxItemId);
  }
}
