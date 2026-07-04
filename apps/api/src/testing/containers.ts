import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

export interface Infra {
  databaseUrl: string;
  redisUrl: string;
  s3Endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  stop(): Promise<void>;
}

const BUCKET = 'plaudern-inbox';
const MINIO_USER = 'minioadmin';
const MINIO_PASSWORD = 'minioadmin';

/**
 * Boots real Postgres + Redis + MinIO in throwaway containers and creates the
 * inbox bucket. This is what lets CI verify the *entire* stack — real presigned
 * uploads, real migrations, real BullMQ — with zero manual setup.
 */
export async function startInfra(): Promise<Infra> {
  const [postgres, redis, minio] = await Promise.all([
    // pgvector image so the embedding_chunks `vector` column + HNSW index
    // migration (ATT-659) applies; drop-in for stock postgres:17 otherwise.
    new PostgreSqlContainer('pgvector/pgvector:pg17')
      .withDatabase('plaudern')
      .withUsername('plaudern')
      .withPassword('plaudern')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
    new GenericContainer('minio/minio:latest')
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
      .start(),
  ]);

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  await createBucket(s3Endpoint);

  return {
    databaseUrl: (postgres as StartedPostgreSqlContainer).getConnectionUri(),
    redisUrl: (redis as StartedRedisContainer).getConnectionUrl(),
    s3Endpoint,
    bucket: BUCKET,
    accessKey: MINIO_USER,
    secretKey: MINIO_PASSWORD,
    stop: async () => {
      await Promise.allSettled([
        postgres.stop(),
        redis.stop(),
        (minio as StartedTestContainer).stop(),
      ]);
    },
  };
}

async function createBucket(endpoint: string): Promise<void> {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    // ignore BucketAlreadyOwnedByYou / already-exists
    if (!/already/i.test((err as Error).message)) throw err;
  } finally {
    client.destroy();
  }
}
