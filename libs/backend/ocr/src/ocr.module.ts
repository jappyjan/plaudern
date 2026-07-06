import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InboxModule } from '@plaudern/inbox';
import { StorageModule } from '@plaudern/storage';
import { TranscriptionModule } from '@plaudern/transcription';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { OCR_PROVIDER } from './ocr.provider';
import { OCR_QUEUE } from './ocr.job';
import { OpenAiVisionOcrProvider } from './providers/openai-vision.provider';
import { OcrProcessor } from './ocr.processor';
import { OcrService } from './ocr.service';
import { OcrExtractor } from './ocr.extractor';
import { InboxOcrController } from './inbox-ocr.controller';

@Module({
  imports: [ConfigModule, InboxModule, StorageModule, TranscriptionModule],
  providers: [
    OpenAiVisionOcrProvider,
    {
      provide: OCR_PROVIDER,
      inject: [OpenAiVisionOcrProvider],
      useFactory: (openai: OpenAiVisionOcrProvider) => openai,
    },
    OcrProcessor,
    {
      provide: OCR_QUEUE,
      inject: [ConfigService, OcrProcessor],
      useFactory: (config: ConfigService, processor: OcrProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'ocr',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    OcrService,
    OcrExtractor,
  ],
  controllers: [InboxOcrController],
  exports: [OcrService, OcrExtractor],
})
export class OcrModule {}
