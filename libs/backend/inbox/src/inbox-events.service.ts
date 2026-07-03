import { Injectable } from '@nestjs/common';
import { filter, map, Subject, type Observable } from 'rxjs';
import type { InboxEvent } from '@plaudern/contracts';

interface UserScopedEvent {
  userId: string;
  event: InboxEvent;
}

/**
 * In-process fan-out of inbox mutations to SSE subscribers. Every event is
 * tagged with its owning user and a subscriber only receives their own
 * events — isolation covers the live stream, not just the REST reads.
 *
 * This only works because every writer (HTTP handlers and the BullMQ worker
 * created inside BullTranscriptionQueue) runs in the same process as the API.
 * If the queue worker is ever split into its own process, this must be
 * replaced with a shared channel (e.g. Redis pub/sub).
 */
@Injectable()
export class InboxEventsService {
  private readonly subject = new Subject<UserScopedEvent>();

  emit(userId: string, event: InboxEvent): void {
    this.subject.next({ userId, event });
  }

  stream(userId: string): Observable<InboxEvent> {
    return this.subject.asObservable().pipe(
      filter((scoped) => scoped.userId === userId),
      map((scoped) => scoped.event),
    );
  }
}
