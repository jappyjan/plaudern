import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { SpeakerIdService, DIARIZATION_EXTRACTOR_VERSION } from './speaker-id.service';

/**
 * Speaker diarization as a node of the extraction DAG: a root extractor (no
 * dependencies) applying to every committed audio source, disabled when the
 * user has no `speaker_id` provider configured. `enqueue` delegates to the
 * existing service so the queue/identifier path is byte-identical to the
 * pre-DAG behavior.
 */
@Injectable()
export class DiarizationExtractor implements Extractor {
  readonly kind = 'diarization' as const;
  readonly version = DIARIZATION_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [];

  constructor(
    private readonly speakerId: SpeakerIdService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'speaker_id');
  }

  appliesTo(item: InboxItemEntity): boolean {
    return (
      item.source?.uploadStatus === 'committed' &&
      item.source.contentType.startsWith('audio/')
    );
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    if (!item.source) return null;
    return this.speakerId.enqueueDiarization(item.userId, item.id, {
      storageKey: item.source.storageKey,
      contentType: item.source.contentType,
    });
  }
}
