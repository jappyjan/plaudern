import { Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { TranscriptionService } from '@plaudern/transcription';
import { SpeakerIdService } from '@plaudern/speaker-id';
import type { SourceAdapter } from '../source-adapter';

/**
 * Generic file upload (plan §2). Uses the same presigned flow as audio. If the
 * uploaded file is itself audio, transcription is scheduled on commit; other
 * file types are stored as-is (future adapters can add OCR etc).
 */
@Injectable()
export class FileAdapter implements SourceAdapter {
  readonly sourceType = 'file' as const;

  constructor(
    private readonly transcription: TranscriptionService,
    private readonly speakerId: SpeakerIdService,
  ) {}

  validateInit(_req: IngestInitRequest): void {
    /* any content type is accepted for generic files */
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    if (item.source?.contentType.startsWith('audio/')) {
      await this.transcription.enqueueTranscription(item.id, {
        storageKey: item.source.storageKey,
        contentType: item.source.contentType,
        filename: item.source.originalFilename ?? undefined,
      });
      await this.speakerId.enqueueDiarization(item.id, {
        storageKey: item.source.storageKey,
        contentType: item.source.contentType,
      });
    }
  }
}
