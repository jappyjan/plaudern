import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { InboxEvent } from '@plaudern/contracts';

/**
 * In-process fan-out of inbox mutations to SSE subscribers.
 *
 * This only works because every writer (HTTP handlers and the BullMQ worker
 * created inside BullTranscriptionQueue) runs in the same process as the API.
 * If the queue worker is ever split into its own process, this must be
 * replaced with a shared channel (e.g. Redis pub/sub).
 */
@Injectable()
export class InboxEventsService {
  private readonly subject = new Subject<InboxEvent>();

  emit(event: InboxEvent): void {
    this.subject.next(event);
  }

  stream(): Observable<InboxEvent> {
    return this.subject.asObservable();
  }
}
