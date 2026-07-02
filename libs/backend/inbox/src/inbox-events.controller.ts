import { Controller, Sse, type MessageEvent } from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import type { InboxEvent } from '@plaudern/contracts';
import { InboxEventsService } from './inbox-events.service';

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Server-sent events for live UI updates. Deliberately not nested under
 * /inbox so it cannot be shadowed by the `GET /inbox/:id` route.
 */
@Controller({ path: 'events', version: '1' })
export class InboxEventsController {
  constructor(private readonly events: InboxEventsService) {}

  @Sse()
  events$(): Observable<MessageEvent> {
    const heartbeat = interval(HEARTBEAT_INTERVAL_MS).pipe(
      map((): InboxEvent => ({ type: 'heartbeat' })),
    );
    return merge(this.events.stream(), heartbeat).pipe(map((data) => ({ data })));
  }
}
