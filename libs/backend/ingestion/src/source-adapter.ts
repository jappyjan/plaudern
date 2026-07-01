import type { IngestInitRequest, SourceType } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';

/**
 * A pluggable ingestion source (plan §2). Adding a new input type = adding one
 * adapter; the ingestion controllers/services stay generic. Each adapter
 * validates its init request and reacts to a committed upload (e.g. audio
 * sources schedule transcription).
 */
export interface SourceAdapter {
  readonly sourceType: SourceType;

  /** Validate/normalize an init request; throw for invalid input. */
  validateInit(req: IngestInitRequest): void;

  /** Hook invoked once the source blob is committed to storage. */
  onCommitted(item: InboxItemEntity): Promise<void>;
}

export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');

/** Registry keyed by SourceType, populated from the DI-provided adapters. */
export class AdapterRegistry {
  private readonly byType = new Map<SourceType, SourceAdapter>();

  constructor(adapters: SourceAdapter[]) {
    for (const adapter of adapters) this.byType.set(adapter.sourceType, adapter);
  }

  get(sourceType: SourceType): SourceAdapter {
    const adapter = this.byType.get(sourceType);
    if (!adapter) throw new Error(`no source adapter registered for '${sourceType}'`);
    return adapter;
  }

  has(sourceType: SourceType): boolean {
    return this.byType.has(sourceType);
  }
}
