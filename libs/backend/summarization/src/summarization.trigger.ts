import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { InboxEventsService } from '@plaudern/inbox';
import { SummarizationService } from './summarization.service';

/**
 * Drives summarization as the next pipeline step after transcription +
 * diarization. Subscribes to the in-process inbox event stream and, whenever a
 * transcription or diarization reaches a terminal state, asks the service
 * whether the item is now ready to summarize. The service's gate guarantees a
 * single summary per generation, so reacting to both kinds is safe.
 */
@Injectable()
export class SummarizationTrigger implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SummarizationTrigger.name);
  private subscription?: Subscription;

  constructor(
    private readonly events: InboxEventsService,
    private readonly summarization: SummarizationService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.allEvents().subscribe(({ event }) => {
      if (event.type !== 'extraction.updated') return;
      if (event.kind !== 'transcription' && event.kind !== 'diarization') return;
      if (event.status !== 'succeeded' && event.status !== 'failed') return;
      // Fire-and-forget: a summarization failure must never break the pipeline.
      void this.summarization.maybeSummarize(event.itemId).catch((err) => {
        this.logger.warn(`maybeSummarize failed for ${event.itemId}: ${(err as Error).message}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
