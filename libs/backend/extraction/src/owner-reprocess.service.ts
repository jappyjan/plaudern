import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { ExtractionKind } from '@plaudern/contracts';
import { OwnerEventsService } from '@plaudern/inbox';
import { ExtractionRunsService } from './extraction-runs.service';

/**
 * The extraction kinds whose output depends on who the account owner ("me") is:
 * commitment direction, the owner's tasks, and the summary's owner attribution.
 * When the owner assignment changes, these must be recomputed for the user's
 * past items — even ones already processed — so a stale (mis-attributed) result
 * never lingers.
 */
const OWNER_DEPENDENT_KINDS: ExtractionKind[] = ['commitments', 'tasks', 'summary'];

/**
 * Reprocesses a user's owner-dependent extractions whenever their "This is me"
 * assignment changes. Subscribes to OwnerEventsService (emitted by the
 * speaker-id contact book) and forces a backfill of each owner-dependent kind
 * via the existing ExtractionRunsService. `force: true` because the extractor
 * version is unchanged — only the owner identity moved — so version-gated
 * skipping must be bypassed.
 *
 * Lives in the extraction lib (not speaker-id) because it drives the backfill
 * machinery; speaker-id would create a module cycle. Best-effort per kind: a
 * kind that is disabled on this server (no API key) simply logs and is skipped.
 */
@Injectable()
export class OwnerReprocessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerReprocessService.name);
  private subscription?: Subscription;

  constructor(
    private readonly ownerEvents: OwnerEventsService,
    private readonly runs: ExtractionRunsService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.ownerEvents.changes().subscribe(({ userId }) => {
      void this.reprocess(userId);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private async reprocess(userId: string): Promise<void> {
    for (const kind of OWNER_DEPENDENT_KINDS) {
      try {
        await this.runs.startBackfill(userId, { kind, force: true });
      } catch (err) {
        // A disabled kind (no provider configured) or a transient error must not
        // stop the other kinds from reprocessing.
        this.logger.warn(
          `owner-change reprocess of '${kind}' for user ${userId} skipped: ${(err as Error).message}`,
        );
      }
    }
  }
}
