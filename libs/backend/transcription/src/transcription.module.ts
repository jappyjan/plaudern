import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';
import { InboxModule } from '@plaudern/inbox';
import { TRANSCRIPTION_PROVIDER } from './transcription.provider';
import { TRANSCRIPTION_QUEUE } from './transcription.job';
import { SidecarTranscriptionProvider } from './providers/sidecar.provider';
import { TranscriptionProcessor } from './transcription.processor';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';
import { InlineTranscriptionQueue } from './queues/inline.queue';
import { BullTranscriptionQueue } from './queues/bull.queue';

function redisConnection(config: ConfigService): ConnectionOptions {
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

@Module({
  imports: [ConfigModule, InboxModule],
  providers: [
    SidecarTranscriptionProvider,
    // Transcription runs exclusively on the self-hosted sidecar (apps/speaker-id-ml).
    { provide: TRANSCRIPTION_PROVIDER, useExisting: SidecarTranscriptionProvider },
    TranscriptionProcessor,
    {
      provide: TRANSCRIPTION_QUEUE,
      inject: [ConfigService, TranscriptionProcessor],
      useFactory: (config: ConfigService, processor: TranscriptionProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullTranscriptionQueue(redisConnection(config), processor)
          : new InlineTranscriptionQueue(processor),
    },
    TranscriptionService,
  ],
  controllers: [TranscriptionController],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
