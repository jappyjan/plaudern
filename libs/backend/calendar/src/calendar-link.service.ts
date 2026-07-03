import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
  CalendarEventEntity,
  CalendarFeedEntity,
  DEFAULT_USER_ID,
  InboxItemEntity,
  RecordingEventLinkEntity,
} from '@plaudern/persistence';
import { recordingDurationMs } from './recording-duration';

/** Inclusive overlap so a zero-duration recording at an event boundary still matches. */
export function overlaps(
  recStart: string,
  recEnd: string,
  eventStart: string,
  eventEnd: string,
): boolean {
  return recStart <= eventEnd && recEnd >= eventStart;
}

/**
 * Owns recording↔event links. Semantics (see RecordingEventLinkEntity):
 * the auto pass inserts missing overlapping pairs and deletes stale *active
 * auto* links; manual links and suppressed tombstones are never touched, so a
 * user's link/unlink decisions survive every future sync.
 */
@Injectable()
export class CalendarLinkService {
  private readonly logger = new Logger(CalendarLinkService.name);

  constructor(
    @InjectRepository(RecordingEventLinkEntity)
    private readonly links: Repository<RecordingEventLinkEntity>,
    @InjectRepository(CalendarEventEntity)
    private readonly events: Repository<CalendarEventEntity>,
    @InjectRepository(CalendarFeedEntity)
    private readonly feeds: Repository<CalendarFeedEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /** Re-evaluates auto links for everything inside [windowStart, windowEnd]. */
  async autoLinkWindow(windowStart: Date, windowEnd: Date): Promise<void> {
    const startIso = windowStart.toISOString();
    const endIso = windowEnd.toISOString();

    const events = await this.events.find({
      where: { userId: DEFAULT_USER_ID, startAt: LessThanOrEqual(endIso), endAt: MoreThanOrEqual(startIso) },
    });

    // Pull recordings from a bit before the window so a long recording that
    // started earlier but runs into the window still gets considered.
    const recordingLookbackMs = 24 * 60 * 60 * 1000;
    const items = await this.items.find({
      select: { id: true, occurredAt: true, metadata: true },
      where: {
        userId: DEFAULT_USER_ID,
        occurredAt: Between(
          new Date(windowStart.getTime() - recordingLookbackMs).toISOString(),
          endIso,
        ),
      },
    });

    // Feeds opted out of auto-linking (e.g. a partner's shared calendar) don't
    // produce new desired pairs, but the toggle only governs *future* linking:
    // existing auto links on those feeds are left untouched (see stale pass).
    const noAutoLink = new Set(
      (await this.feeds.find({ where: { userId: DEFAULT_USER_ID, autoLink: false }, select: { id: true } })).map(
        (feed) => feed.id,
      ),
    );

    // In-memory join — fine at single-user scale (bounded by the sync window).
    const desired = new Set<string>();
    for (const item of items) {
      const recStart = item.occurredAt;
      const duration = recordingDurationMs(item.metadata) ?? 0;
      const recEnd = new Date(Date.parse(recStart) + duration).toISOString();
      for (const event of events) {
        if (noAutoLink.has(event.feedId)) continue;
        if (overlaps(recStart, recEnd, event.startAt, event.endAt)) {
          desired.add(pairKey(item.id, event.id));
        }
      }
    }

    const itemIds = items.map((item) => item.id);
    const eventIds = events.map((event) => event.id);
    const existing = [
      ...(itemIds.length > 0 ? await this.links.find({ where: { inboxItemId: In(itemIds) } }) : []),
      ...(eventIds.length > 0
        ? await this.links.find({ where: { calendarEventId: In(eventIds) } })
        : []),
    ];
    const existingByPair = new Map<string, RecordingEventLinkEntity>();
    for (const link of existing) {
      existingByPair.set(pairKey(link.inboxItemId, link.calendarEventId), link);
    }
    const feedByEventId = new Map(events.map((event) => [event.id, event.feedId]));

    let inserted = 0;
    for (const pair of desired) {
      if (existingByPair.has(pair)) continue;
      const [inboxItemId, calendarEventId] = splitPairKey(pair);
      await this.links.save(
        this.links.create({
          userId: DEFAULT_USER_ID,
          inboxItemId,
          calendarEventId,
          origin: 'auto',
          status: 'active',
        }),
      );
      inserted += 1;
    }

    // An event that moved away from a recording takes its stale auto link
    // with it. Manual links and suppressed tombstones stay untouched.
    let removed = 0;
    for (const link of existingByPair.values()) {
      if (link.origin !== 'auto' || link.status !== 'active') continue;
      if (desired.has(pairKey(link.inboxItemId, link.calendarEventId))) continue;
      // A feed that turned auto-link off keeps its already-linked recordings;
      // the toggle only stops new links, it never retroactively unlinks.
      if (noAutoLink.has(feedByEventId.get(link.calendarEventId) ?? '')) continue;
      await this.links.delete({ id: link.id });
      removed += 1;
    }

    if (inserted > 0 || removed > 0) {
      this.logger.log(`auto-link: ${inserted} links added, ${removed} stale links removed`);
    }
  }

  /** Manual link; revives a suppressed pair and upgrades an auto link. */
  async link(inboxItemId: string, eventId: string): Promise<RecordingEventLinkEntity> {
    const item = await this.items.findOne({ where: { id: inboxItemId, userId: DEFAULT_USER_ID } });
    if (!item) throw new NotFoundException('inbox item not found');
    const event = await this.events.findOne({ where: { id: eventId, userId: DEFAULT_USER_ID } });
    if (!event) throw new NotFoundException('calendar event not found');

    const existing = await this.links.findOne({
      where: { inboxItemId, calendarEventId: eventId },
    });
    if (existing) {
      existing.origin = 'manual';
      existing.status = 'active';
      return this.links.save(existing);
    }
    return this.links.save(
      this.links.create({
        userId: DEFAULT_USER_ID,
        inboxItemId,
        calendarEventId: eventId,
        origin: 'manual',
        status: 'active',
      }),
    );
  }

  /** Unlink = suppress. The tombstone stops the auto pass from re-linking. */
  async unlink(inboxItemId: string, eventId: string): Promise<void> {
    const existing = await this.links.findOne({
      where: { inboxItemId, calendarEventId: eventId, status: 'active' },
    });
    if (!existing) throw new NotFoundException('link not found');
    existing.status = 'suppressed';
    await this.links.save(existing);
  }
}

function pairKey(inboxItemId: string, eventId: string): string {
  return `${inboxItemId}|${eventId}`;
}

function splitPairKey(pair: string): [string, string] {
  const [inboxItemId, eventId] = pair.split('|');
  return [inboxItemId, eventId];
}
