import { BadRequestException } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Shared behaviour for audio-bearing sources: validate the content type and
 * kick off the extraction DAG on commit (transcription + diarization roots
 * today; new kinds ride along automatically). `generic audio` and `plaud`
 * extend this so they run through the exact same commit path (plan §2).
 */
export abstract class AudioSourceAdapter implements SourceAdapter {
  abstract readonly sourceType: 'audio' | 'plaud';

  constructor(protected readonly pipeline: ExtractionPipelineService) {}

  validateInit(req: IngestInitRequest): void {
    if (!req.contentType.startsWith('audio/')) {
      throw new BadRequestException(
        `source '${this.sourceType}' expects an audio content type, got '${req.contentType}'`,
      );
    }
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    await this.pipeline.processCommitted(item);
  }
}
