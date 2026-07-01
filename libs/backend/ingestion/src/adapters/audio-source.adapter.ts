import { BadRequestException } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { TranscriptionService } from '@plaudern/transcription';
import type { SourceAdapter } from '../source-adapter';

/**
 * Shared behaviour for audio-bearing sources: validate the content type and
 * schedule transcription on commit. `generic audio` and `plaud` extend this so
 * they run through the exact same commit/transcription path (plan §2).
 */
export abstract class AudioSourceAdapter implements SourceAdapter {
  abstract readonly sourceType: 'audio' | 'plaud';

  constructor(protected readonly transcription: TranscriptionService) {}

  validateInit(req: IngestInitRequest): void {
    if (!req.contentType.startsWith('audio/')) {
      throw new BadRequestException(
        `source '${this.sourceType}' expects an audio content type, got '${req.contentType}'`,
      );
    }
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    if (!item.source) return;
    await this.transcription.enqueueTranscription(item.id, {
      storageKey: item.source.storageKey,
      contentType: item.source.contentType,
      filename: item.source.originalFilename ?? undefined,
    });
  }
}
