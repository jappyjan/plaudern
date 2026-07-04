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
    return this.toEventDtos(events);
  }

  async eventDetail(userId: string, id: string): Promise<CalendarEventDetailDto> {
    const event = await this.events.findOne({ where: { id, userId } });
    if (!event) throw new NotFoundException('calendar event not found');
    const [dto] = await this.toEventDtos([event]);

    const links = await this.links.find({ where: { calendarEventId: id, status: 'active' } });
    const recordings = await this.recordingSummaries(links.map((link) => link.inboxItemId));
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
    const hidden = new Set(
      (
        await this.merges.find({ select: { sourceItemId: true }, where: { userId } })
      ).map((link) => link.sourceItemId),
    );
    return this.toRecordingSummaries(items.filter((item) => !hidden.has(item.id)));
  }

  /** Events actively linked to one inbox item. */
  async eventsForItem(userId: string, inboxItemId: string): Promise<CalendarEventDto[]> {
    const item = await this.items.findOne({
      where: { id: inboxItemId, userId },
    });
    if (!item) throw new NotFoundException('inbox item not found');
    const links = await this.links.find({ where: { inboxItemId, status: 'active' } });
    if (links.length === 0) return [];
    const events = await this.events.find({
      where: { id: In(links.map((link) => link.calendarEventId)) },
      order: { startAt: 'ASC' },
    });
    return this.toEventDtos(events);
  }

  private async recordingSummaries(itemIds: string[]): Promise<RecordingSummaryDto[]> {
    if (itemIds.length === 0) return [];
    const items = await this.items.find({
      where: { id: In(itemIds) },
      relations: { source: true },
      order: { occurredAt: 'ASC' },
    });
    return this.toRecordingSummaries(items);
  }

  private async toEventDtos(events: CalendarEventEntity[]): Promise<CalendarEventDto[]> {
    if (events.length === 0) return [];
    const feeds = await this.feeds.find({
      where: { id: In([...new Set(events.map((event) => event.feedId))]) },
    });
    const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
    const links = await this.links.find({
      where: { calendarEventId: In(events.map((event) => event.id)), status: 'active' },
    });
    const linksByEvent = new Map<string, string[]>();
    for (const link of links) {
      const list = linksByEvent.get(link.calendarEventId) ?? [];
      list.push(link.inboxItemId);
      linksByEvent.set(link.calendarEventId, list);
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
      linkedRecordingIds: linksByEvent.get(event.id) ?? [],
    }));
  }

  private async toRecordingSummaries(items: InboxItemEntity[]): Promise<RecordingSummaryDto[]> {
    if (items.length === 0) return [];
    const links = await this.links.find({
      where: { inboxItemId: In(items.map((item) => item.id)), status: 'active' },
    });
    const linksByItem = new Map<string, string[]>();
    for (const link of links) {
      const list = linksByItem.get(link.inboxItemId) ?? [];
      list.push(link.calendarEventId);
      linksByItem.set(link.inboxItemId, list);
    }
    return items.map((item) => ({
      id: item.id,
      sourceType: item.sourceType,
      occurredAt: item.occurredAt,
      durationMs: recordingDurationMs(item.metadata),
      originalFilename: item.source?.originalFilename ?? null,
      linkedEventIds: linksByItem.get(item.id) ?? [],
    }));
  }
}
