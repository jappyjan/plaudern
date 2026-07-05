import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

/** Emitted when a user's account-owner ("This is me") assignment changes. */
export interface OwnerChangedEvent {
  userId: string;
}

/**
 * In-process fan-out for account-owner ("me") changes. Marking, moving, or
 * clearing the self voice profile changes the meaning of every owner-relative
 * extraction (commitment direction, the owner's tasks, summary attribution), so
 * those items must be reprocessed. The reprocess itself lives in the extraction
 * lib, which already depends on @plaudern/speaker-id — so speaker-id cannot
 * depend back on it. This bus decouples the two: speaker-id `emit`s here and the
 * extraction lib subscribes, mirroring how InboxEventsService drives the
 * event-driven pipeline. In-process only (single API process), like its sibling.
 */
@Injectable()
export class OwnerEventsService {
  private readonly subject = new Subject<OwnerChangedEvent>();

  emit(event: OwnerChangedEvent): void {
    this.subject.next(event);
  }

  changes(): Observable<OwnerChangedEvent> {
    return this.subject.asObservable();
  }
}
