import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { QuestionsService, QUESTIONS_EXTRACTOR_VERSION } from './questions.service';

/**
 * Question extraction as a node of the extraction DAG (JJ-34). Depends on
 * transcription (required — nothing to extract without a transcript) and, when
 * they apply, on diarization and summary (settled — wait so speaker labels are
 * available for direction attribution, but a missing/failed diarization or
 * summary must not block extraction; the plain transcript is used instead).
 * Mirrors the commitments extractor's dependency shape.
 */
@Injectable()
export class QuestionsExtractor implements Extractor {
  readonly kind = 'questions' as const;
  readonly version = QUESTIONS_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'diarization', requires: 'settled' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(
    private readonly questions: QuestionsService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'questions');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.questions.enqueueQuestions(item.id);
  }
}
