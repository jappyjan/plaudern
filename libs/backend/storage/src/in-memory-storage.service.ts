import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { ObjectHead, PresignedUpload, StorageService } from './storage.service';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/**
 * In-memory storage for tests and hardware-free local runs. Presigned URLs are
 * fake `memory://` URLs; `putObject` simulates the client's direct upload so the
 * full init -> upload -> commit -> transcribe pipeline runs without MinIO.
 */
@Injectable()
export class InMemoryStorageService extends StorageService {
  private readonly objects = new Map<string, StoredObject>();

  async createPresignedPutUrl(storageKey: string, _contentType: string): Promise<string> {
    return `memory://put/${encodeURIComponent(storageKey)}`;
  }

  async createPresignedGetUrl(storageKey: string): Promise<string> {
    return `memory://get/${encodeURIComponent(storageKey)}`;
  }

  async putObject(
    storageKey: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    const buf =
      typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);
    this.objects.set(storageKey, { body: buf, contentType });
  }

  async headObject(storageKey: string): Promise<ObjectHead> {
    const obj = this.objects.get(storageKey);
    if (!obj) return { exists: false, byteSize: 0 };
    return { exists: true, byteSize: obj.body.byteLength, contentType: obj.contentType };
  }

  async getObjectStream(storageKey: string): Promise<Readable> {
    const obj = this.objects.get(storageKey);
    if (!obj) throw new Error(`object not found: ${storageKey}`);
    return Readable.from(obj.body);
  }

  /** Test helper: emulate the client PUT to a presigned URL. */
  simulateUpload(upload: PresignedUpload | string, body: Buffer, contentType = 'application/octet-stream') {
    const key = typeof upload === 'string' ? upload : upload.storageKey;
    return this.putObject(key, body, contentType);
  }
}
