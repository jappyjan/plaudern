import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ObjectHead, StorageService } from './storage.service';

/**
 * S3-compatible implementation (AWS S3 in prod, MinIO in dev). MinIO requires
 * `forcePathStyle` and a custom endpoint.
 */
@Injectable()
export class S3StorageService extends StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  /** Internal client for server-side ops (head/get/put), uses S3_ENDPOINT. */
  private readonly client: S3Client;
  /**
   * Client used only to sign URLs. Uses S3_PUBLIC_ENDPOINT so the URLs handed
   * to external clients (the mobile app) are reachable from outside the docker
   * network — the internal S3_ENDPOINT (e.g. http://minio:9000) is not.
   */
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly presignTtl: number;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.get<string>('S3_BUCKET', 'plaudern-inbox');
    this.presignTtl = Number(config.get<string>('S3_PRESIGN_TTL', '900'));

    const region = config.get<string>('S3_REGION', 'us-east-1');
    const forcePathStyle = config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';
    const credentials = {
      accessKeyId: config.get<string>('S3_ACCESS_KEY', 'minioadmin'),
      secretAccessKey: config.get<string>('S3_SECRET_KEY', 'minioadmin'),
    };
    const endpoint = config.get<string>('S3_ENDPOINT');
    const publicEndpoint = config.get<string>('S3_PUBLIC_ENDPOINT') ?? endpoint;

    this.client = new S3Client({ region, endpoint, forcePathStyle, credentials });
    this.presignClient =
      publicEndpoint === endpoint
        ? this.client
        : new S3Client({ region, endpoint: publicEndpoint, forcePathStyle, credentials });
  }

  async createPresignedPutUrl(storageKey: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ContentType: contentType,
    });
    return getSignedUrl(this.presignClient, command, { expiresIn: this.presignTtl });
  }

  async createPresignedGetUrl(storageKey: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: storageKey });
    return getSignedUrl(this.presignClient, command, { expiresIn: this.presignTtl });
  }

  async createInternalPresignedGetUrl(storageKey: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: storageKey });
    return getSignedUrl(this.client, command, { expiresIn: this.presignTtl });
  }

  async putObject(
    storageKey: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async headObject(storageKey: string): Promise<ObjectHead> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return {
        exists: true,
        byteSize: Number(res.ContentLength ?? 0),
        contentType: res.ContentType,
      };
    } catch (err) {
      this.logger.debug(`headObject miss for ${storageKey}: ${(err as Error).message}`);
      return { exists: false, byteSize: 0 };
    }
  }

  async getObjectStream(storageKey: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    return res.Body as Readable;
  }

  async deleteObject(storageKey: string): Promise<void> {
    // S3 DeleteObject succeeds for missing keys, so this is naturally idempotent.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
  }
}
