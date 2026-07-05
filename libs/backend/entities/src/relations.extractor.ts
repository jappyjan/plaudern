import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { RelationsService, RELATIONS_EXTRACTOR_VERSION } from './relations.service';

/**
 * Relation extraction as a node of the extraction DAG (JJ-22). Depends on
 * `entities` succeeding (required — the extracted entities are the only legal
 * relation endpoints), which in turn depends on transcription; the DAG chains
 * transcription → entities → relations automatically.
 */
@Injectable()
export class RelationsExtractor implements Extractor {
  readonly kind = 'relations' as const;
  readonly version = RELATIONS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'entities', requires: 'succeeded' },
  ];

  constructor(
    private readonly relations: RelationsService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'entity_relations');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required entities dependency does
    // the real gating (no entities extraction, no relations).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.relations.enqueueRelations(item.id);
  }
}
