import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { EntitiesService, ENTITIES_EXTRACTOR_VERSION } from './entities.service';

/**
 * Named-entity extraction as a node of the extraction DAG (JJ-32). Depends on
 * transcription (required — there is nothing to extract entities from without a
 * transcript). Independent of diarization: person entities are linked to the
 * contact book by name, not by voice, so a missing diarization must not block
 * extraction.
 */
@Injectable()
export class EntitiesExtractor implements Extractor {
  readonly kind = 'entities' as const;
  readonly version = ENTITIES_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
  ];

  constructor(
    private readonly entities: EntitiesService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'entity_extraction');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.entities.enqueueEntities(item.id);
  }
}
