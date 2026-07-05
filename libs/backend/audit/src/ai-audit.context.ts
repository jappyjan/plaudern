import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The item/kind/user attribution for any external AI-provider call made inside
 * a job. Processors establish this once (they know the owning user, the item,
 * and the extraction kind); provider adapters deep in the call stack read it
 * back when they record an audited call — so a new provider is covered
 * automatically the moment it runs inside a context, without threading userId
 * through its signature.
 */
export interface AiAuditContext {
  userId: string;
  /** The inbox item the call is for; omitted for non-item-scoped calls. */
  itemId?: string | null;
  /** Extraction/generation kind driving the call (e.g. `summary`). */
  kind: string;
}

/**
 * Module-level singleton so the setter (processors) and the reader (the
 * recorder) share one store. AsyncLocalStorage propagates across every `await`
 * in the callback, so the context set before a provider call is still visible
 * when that provider records — even several async hops later.
 */
const storage = new AsyncLocalStorage<AiAuditContext>();

/** Run `fn` with the given audit attribution active for its whole async tree. */
export function runWithAiAudit<T>(context: AiAuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The audit attribution active on the current async stack, or undefined. */
export function getAiAuditContext(): AiAuditContext | undefined {
  return storage.getStore();
}
