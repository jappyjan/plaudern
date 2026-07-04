import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import type {
  CalendarEventDetailDto,
  CalendarEventDto,
  RecordingSummaryDto,
} from '@plaudern/contracts';
import {
  CalendarEventEntity,
  CalendarFeedEntity,
  InboxItemEntity,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
} from '@plaudern/persistence';
import { recordingDurationMs } from './recording-duration';

/** Read side of the calendar: range queries and link-aware detail views. */
@Injectable()
export class CalendarEventsService {
  constructor(
    @InjectRepository(CalendarEventEntity)
    private readonly events: Repository<CalendarEventEntity>,
    @InjectRepository(CalendarFeedEntity)
    private readonly feeds: Repository<CalendarFeedEntity>,
    @InjectRepository(RecordingEventLinkEntity)
    private readonly links: Repository<RecordingEventLinkEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(RecordingMergeEntity)
    private readonly merges: Repository<RecordingMergeEntity>,
  ) {}

  /** Events overlapping [from, to], with active linked recording ids. */
  async eventsInRange(userId: string, from: string, to: string): Promise<CalendarEventDto[]> {
    const events = await this.events.find({
      where: { userId, startAt: LessThanOrEqual(to), endAt: MoreThanOrEqual(from) },
      order: { startAt: 'ASC' },
    });
    return this.toEventDtos(userId, events);
  }

  async eventDetail(userId: string, id: string): Promise<CalendarEventDetailDto> {
    const event = await this.events.findOne({ where: { id, userId } });
    if (!event) throw new NotFoundException('calendar event not found');
    const [dto] = await this.toEventDtos(userId, [event]);

    const { sourceToMerged } = await this.mergeMaps(userId);
    const links = await this.links.find({ where: { calendarEventId: id, status: 'active' } });
    // A recording hidden inside a merge is represented by the merged item — its
    // link stays in the table so a split restores the individual recording.
    const recordingIds = [
      ...new Set(links.map((link) => sourceToMerged.get(link.inboxItemId) ?? link.inboxItemId)),
    ];
    const recordings = await this.recordingSummaries(userId, recordingIds);
    return { ...dto, recordings };
  }

  /**
   * Recordings (inbox items) whose occurredAt falls in [from, to]. Sources
   * hidden inside a merged recording are excluded, matching the inbox list —
   * the merged item covers their time range.
   */
  async recordingsInRange(userId: string, from: string, to: string): Promise<RecordingSummaryDto[]> {
    const items = await this.items.find({
      where: { userId, occurredAt: Between(from, to) },
      relations: { source: true },
      order: { occurredAt: 'ASC' },
    });
    const { sourceToMerged } = await this.mergeMaps(userId);
    return this.toRecordingSummaries(
      userId,
      items.filter((item) => !sourceToMerged.has(item.id)),
    );
  }

  /** Events actively linked to one inbox item. */
  async eventsForItem(userId: string, inboxItemId: string): Promise<CalendarEventDto[]> {
    const item = await this.items.findOne({
      where: { id: inboxItemId, userId },
    });
    if (!item) throw new NotFoundException('inbox item not found');
    // A merged item inherits the events its source recordings were linked to,
    // so its detail page shows the meetings its parts belong to.
    const { mergedToSources } = await this.mergeMaps(userId);
    const itemIds = [inboxItemId, ...(mergedToSources.get(inboxItemId) ?? [])];
    const links = await this.links.find({
      where: { inboxItemId: In(itemIds), status: 'active' },
    });
    if (links.length === 0) return [];
    const events = await this.events.find({
      where: { id: In([...new Set(links.map((link) => link.calendarEventId))]) },
      order: { startAt: 'ASC' },
    });
    return this.toEventDtos(userId, events);
  }

  private async recordingSummaries(
    userId: string,
    itemIds: string[],
  ): Promise<RecordingSummaryDto[]> {
    if (itemIds.length === 0) return [];
    const items = await this.items.find({
      where: { id: In(itemIds) },
      relations: { source: true },
      order: { occurredAt: 'ASC' },
    });
    return this.toRecordingSummaries(userId, items);
  }

  private async toEventDtos(
    userId: string,
    events: CalendarEventEntity[],
  ): Promise<CalendarEventDto[]> {
    if (events.length === 0) return [];
    const feeds = await this.feeds.find({
      where: { id: In([...new Set(events.map((event) => event.feedId))]) },
    });
    const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
    const { sourceToMerged } = await this.mergeMaps(userId);
    const links = await this.links.find({
      where: { calendarEventId: In(events.map((event) => event.id)), status: 'active' },
    });
    const linksByEvent = new Map<string, Set<string>>();
    for (const link of links) {
      // Show the merged recording in place of any hidden source; a split drops
      // the merge rows, so the individual recordings resurface automatically.
      const itemId = sourceToMerged.get(link.inboxItemId) ?? link.inboxItemId;
      const set = linksByEvent.get(link.calendarEventId) ?? new Set<string>();
      set.add(itemId);
      linksByEvent.set(link.calendarEventId, set);
    }
    return events.map((event) => ({
      id: event.id,
      feedId: event.feedId,
      feedName: feedById.get(event.feedId)?.name ?? '',
      feedColor: feedById.get(event.feedId)?.color ?? null,
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      linkedRecordingIds: [...(linksByEvent.get(event.id) ?? [])],
    }));
  }

  /**
   * Merge link maps for a user, resolved once per request. Recordings hidden
   * inside a merge are never deleted, so the calendar keeps their event links
   * and simply *projects* them onto the merged recording at read time — which
   * makes splitting a merge automatically revert the links to the originals.
   */
  private async mergeMaps(
    userId: string,
  ): Promise<{ sourceToMerged: Map<string, string>; mergedToSources: Map<string, string[]> }> {
    const rows = await this.merges.find({
      select: { sourceItemId: true, mergedItemId: true },
      where: { userId },
    });
    const sourceToMerged = new Map<string, string>();
    const mergedToSources = new Map<string, string[]>();
    for (const row of rows) {
      sourceToMerged.set(row.sourceItemId, row.mergedItemId);
      const sources = mergedToSources.get(row.mergedItemId) ?? [];
      sources.push(row.sourceItemId);
      mergedToSources.set(row.mergedItemId, sources);
    }
    return { sourceToMerged, mergedToSources };
  }

  private async toRecordingSummaries(
    userId: string,
    items: InboxItemEntity[],
  ): Promise<RecordingSummaryDto[]> {
    if (items.length === 0) return [];
    // A merged item inherits its sources' event links, so its own linkedEventIds
    // reflect the meetings its parts belong to (mirrors eventsForItem).
    const { mergedToSources } = await this.mergeMaps(userId);
    const lookupIds = items.flatMap((item) => [item.id, ...(mergedToSources.get(item.id) ?? [])]);
    const links = await this.links.find({
      where: { inboxItemId: In([...new Set(lookupIds)]), status: 'active' },
    });
    const eventsByItem = new Map<string, Set<string>>();
    for (const link of links) {
      const set = eventsByItem.get(link.inboxItemId) ?? new Set<string>();
      set.add(link.calendarEventId);
      eventsByItem.set(link.inboxItemId, set);
    }
    const linkedEventIdsFor = (itemId: string): string[] => {
      const own = eventsByItem.get(itemId) ?? new Set<string>();
      const inherited = (mergedToSources.get(itemId) ?? []).flatMap((sourceId) => [
        ...(eventsByItem.get(sourceId) ?? []),
      ]);
      return [...new Set([...own, ...inherited])];
    };
    return items.map((item) => ({
      id: item.id,
      sourceType: item.sourceType,
      occurredAt: item.occurredAt,
      durationMs: recordingDurationMs(item.metadata),
      originalFilename: item.source?.originalFilename ?? null,
      linkedEventIds: linkedEventIdsFor(item.id),
    }));
  }
}
