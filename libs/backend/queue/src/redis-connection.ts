import { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';

/** BullMQ connection options from REDIS_URL, or REDIS_HOST/REDIS_PORT. */
export function redisConnectionFromConfig(config: ConfigService): ConnectionOptions {
  const url = config.get<string>('REDIS_URL');
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || '6379'),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    };
  }
  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: Number(config.get<string>('REDIS_PORT', '6379')),
  };
}
