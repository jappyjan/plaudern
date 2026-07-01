import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
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
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtl: number;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.get<string>('S3_BUCKET', 'plaudern-inbox');
    this.presignTtl = Number(config.get<string>('S3_PRESIGN_TTL', '900'));
    this.client = new S3Client({
      region: config.get<string>('S3_REGION', 'us-east-1'),
      endpoint: config.get<string>('S3_ENDPOINT'),
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true',
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY', 'minioadmin'),
        secretAccessKey: config.get<string>('S3_SECRET_KEY', 'minioadmin'),
      },
    });
  }

  async createPresignedPutUrl(storageKey: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn: this.presignTtl });
  }

  async createPresignedGetUrl(storageKey: string): Promise<string> {
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
}
