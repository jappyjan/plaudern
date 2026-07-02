import { Readable } from 'node:stream';

export interface ObjectHead {
  exists: boolean;
  byteSize: number;
  contentType?: string;
}

export interface PresignedUpload {
  url: string;
  storageKey: string;
}

/**
 * Blob storage abstraction. The rest of the backend depends only on this class
 * (a Nest DI token), so S3/MinIO can be swapped for an in-memory fake in tests
 * without touching ingestion/transcription (plan §2).
 */
export abstract class StorageService {
  /** Presigned PUT so the client uploads bytes directly to storage (plan §3). */
  abstract createPresignedPutUrl(
    storageKey: string,
    contentType: string,
  ): Promise<string>;

  /** Presigned GET for playback/download in the app. */
  abstract createPresignedGetUrl(storageKey: string): Promise<string>;

  /**
   * Presigned GET signed for the INTERNAL endpoint, for server-to-server
   * consumers on the same network (e.g. the speaker-id sidecar). The public
   * variant may point at a host only external clients can reach.
   */
  abstract createInternalPresignedGetUrl(storageKey: string): Promise<string>;

  /** Server-side write, used for inline text payloads and tests. */
  abstract putObject(
    storageKey: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void>;

  /** Verify an uploaded object exists and read its size at commit time. */
  abstract headObject(storageKey: string): Promise<ObjectHead>;

  /** Stream an object, e.g. to hand to a transcription provider. */
  abstract getObjectStream(storageKey: string): Promise<Readable>;

  /** Idempotent delete; a missing object is not an error. */
  abstract deleteObject(storageKey: string): Promise<void>;
}
