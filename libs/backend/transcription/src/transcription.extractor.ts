import { Injectable } from '@nestjs/common';
import { isTextBearing } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import {
  TRANSCRIPTION_EXTRACTOR_VERSION,
  TranscriptionService,
} from './transcription.service';

/**
 * Is this a text-bearing source whose payload is the content itself (typed
 * note, web-clip snapshot, email body, plain-text file upload)? Audio-bearing
 * sources are excluded via the sourceType gate; non-text payloads (PDFs,
 * images, ...) via the contentType gate.
 */
function isPassthroughSource(item: InboxItemEntity): boolean {
  return (
    isTextBearing(item.sourceType) &&
    (item.source?.contentType.startsWith('text/') ?? false)
  );
}

/**
 * Transcription as a node of the extraction DAG: a root extractor (no
 * dependencies) applying to every committed audio source. `enqueue` delegates
 * to the existing service so the queue/provider path is byte-identical to the
 * pre-DAG behavior.
 *
 * Text-bearing sources also apply: they get a passthrough row whose content is
 * the stored note body, so the downstream DAG (summary, entities, ...) runs
 * for typed notes exactly as it does for recordings.
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
    if (item.source?.uploadStatus !== 'committed') return false;
    return (
      item.source.contentType.startsWith('audio/') || isPassthroughSource(item)
    );
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    if (!item.source) return null;
    return this.transcription.enqueueTranscription(item.id, {
      storageKey: item.source.storageKey,
      contentType: item.source.contentType,
      filename: item.source.originalFilename ?? undefined,
      passthrough: isPassthroughSource(item),
    });
  }
}
