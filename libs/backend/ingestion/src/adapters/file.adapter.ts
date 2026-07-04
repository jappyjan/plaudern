import { Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Generic file upload (plan §2). Uses the same presigned flow as audio. On
 * commit the extraction DAG decides what applies: audio files get
 * transcription + diarization; other file types are stored as-is until an
 * extractor (e.g. OCR) declares itself applicable.
 */
@Injectable()
export class FileAdapter implements SourceAdapter {
  readonly sourceType = 'file' as const;

  constructor(private readonly pipeline: ExtractionPipelineService) {}

  validateInit(_req: IngestInitRequest): void {
    /* any content type is accepted for generic files */
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    await this.pipeline.processCommitted(item);
  }
}
