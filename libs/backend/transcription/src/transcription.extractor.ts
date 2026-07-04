import { Injectable } from '@nestjs/common';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import {
  TRANSCRIPTION_EXTRACTOR_VERSION,
  TranscriptionService,
} from './transcription.service';

/**
 * Transcription as a node of the extraction DAG: a root extractor (no
 * dependencies) applying to every committed audio source. `enqueue` delegates
 * to the existing service so the queue/provider path is byte-identical to the
 * pre-DAG behavior.
 */
@Injectable()
export class TranscriptionExtractor implements Extractor {
  readonly kind = 'transcription' as const;
  readonly version = TRANSCRIPTION_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [];

  constructor(private readonly transcription: TranscriptionService) {}

  enabled(): boolean {
    return true; // transcription is always configured (hosted provider)
  }

  appliesTo(item: InboxItemEntity): boolean {
    return (
      item.source?.uploadStatus === 'committed' &&
      item.source.contentType.startsWith('audio/')
    );
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    if (!item.source) return null;
    return this.transcription.enqueueTranscription(item.id, {
      storageKey: item.source.storageKey,
      contentType: item.source.contentType,
      filename: item.source.originalFilename ?? undefined,
    });
  }
}
