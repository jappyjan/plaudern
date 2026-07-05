import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityContactResolverService } from './entity-contact-resolver.service';

/** Default delay before the sweep fires, letting migrations/queues settle. */
const DEFAULT_DELAY_MS = 20_000;

/**
 * Automatic contact resolution over EXISTING data on every boot, mirroring the
 * extraction StartupBackfillService: items processed before the resolver
 * shipped (or before their contact was named) have entities in the registry
 * that nothing would ever re-visit — the per-item resolution hooks only fire
 * when an entities/relations extraction runs. This sweep re-resolves every
 * still-unlinked person entity from the data already stored (mentions, voices,
 * graph), so no LLM re-extraction of documents is needed.
 *
 * Safe to run concurrently across replicas: the sweep is idempotent (linked
 * and user-suppressed entities are skipped), so no advisory lock is taken —
 * the worst case is a duplicated (cheap) resolution pass. Non-blocking: boot
 * only arms an unref'd timer.
 */
@Injectable()
export class ContactResolutionStartupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ContactResolutionStartupService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: EntityContactResolverService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('CONTACT_RESOLUTION_STARTUP_ENABLED', 'true') !== 'true') {
      this.logger.log(
        'startup contact resolution disabled (CONTACT_RESOLUTION_STARTUP_ENABLED=false)',
      );
      return;
    }
    const delay = Number(
      this.config.get<string>('CONTACT_RESOLUTION_STARTUP_DELAY_MS', String(DEFAULT_DELAY_MS)),
    );
    this.logger.log(`startup contact resolution armed; sweeping in ${delay}ms`);
    this.timer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`startup contact resolution crashed: ${(err as Error).message}`),
      );
    }, delay);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Exposed for tests; normally fired by the armed timer. */
  async sweep(): Promise<number> {
    if (this.destroyed) return 0;
    const linked = await this.resolver.autoLinkAllUsers();
    this.logger.log(`startup contact resolution linked ${linked} person entities`);
    return linked;
  }
}
