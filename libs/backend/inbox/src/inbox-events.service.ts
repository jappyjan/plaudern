import { Injectable } from '@nestjs/common';
import { filter, map, Subject, type Observable } from 'rxjs';
import type { InboxEvent } from '@plaudern/contracts';

export interface UserScopedEvent {
  userId: string;
  event: InboxEvent;
}

/**
 * In-process fan-out of inbox mutations to SSE subscribers. Every event is
 * tagged with its owning user and a subscriber only receives their own
 * events — isolation covers the live stream, not just the REST reads.
 *
 * This only works because every writer (HTTP handlers and the BullMQ worker
 * created inside BullJobQueue) runs in the same process as the API.
 * If the queue worker is ever split into its own process, this must be
 * replaced with a shared channel (e.g. Redis pub/sub).
 */
@Injectable()
export class InboxEventsService {
  private readonly subject = new Subject<UserScopedEvent>();

  emit(userId: string, event: InboxEvent): void {
    this.subject.next({ userId, event });
  }

  /**
   * Unfiltered, user-tagged stream of every event — for in-process pipeline
   * steps (e.g. summarization) that react to extraction completions across all
   * users. SSE subscribers use the per-user `stream` instead.
   */
  allEvents(): Observable<UserScopedEvent> {
    return this.subject.asObservable();
  }

  stream(userId: string): Observable<InboxEvent> {
    return this.subject.asObservable().pipe(
      filter((scoped) => scoped.userId === userId),
      map((scoped) => scoped.event),
    );
  }
}
