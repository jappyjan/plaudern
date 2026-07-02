import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  calendarFeedTestRequestSchema,
  calendarRangeQuerySchema,
  createCalendarFeedRequestSchema,
  createLinkRequestSchema,
  updateCalendarFeedRequestSchema,
  type CalendarEventDetailDto,
  type CalendarEventsResponse,
  type CalendarFeedDto,
  type CalendarFeedsResponse,
  type CalendarFeedTestResponse,
  type CalendarRecordingsResponse,
  type CalendarSyncNowResponse,
  type ItemEventsResponse,
  type LinkResponse,
} from '@plaudern/contracts';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarFeedsService } from './calendar-feeds.service';
import { CalendarLinkService } from './calendar-link.service';
import { CalendarSyncService } from './calendar-sync.service';
import { IcsCalendarProvider } from './ics/ics-calendar.provider';

@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  private readonly logger = new Logger(CalendarController.name);

  constructor(
    private readonly feeds: CalendarFeedsService,
    private readonly events: CalendarEventsService,
    private readonly links: CalendarLinkService,
    private readonly sync: CalendarSyncService,
    private readonly icsProvider: IcsCalendarProvider,
  ) {}

  @Get('feeds')
  async listFeeds(): Promise<CalendarFeedsResponse> {
    const feeds = await this.feeds.list();
    return { feeds: feeds.map((feed) => this.feeds.toDto(feed)), syncRunning: this.sync.isRunning };
  }

  @Post('feeds')
  async createFeed(@Body() body: unknown): Promise<CalendarFeedDto> {
    const req = createCalendarFeedRequestSchema.parse(body);
    // Prove the URL is fetchable and parseable before storing it.
    const test = await this.icsProvider.testConnection(req.url);
    if (!test.ok) {
      throw new BadRequestException(`feed test failed: ${test.error}`);
    }
    const feed = await this.feeds.create(req);
    this.fireAndForgetSync('post-create');
    return this.feeds.toDto(feed);
  }

  @Put('feeds/:id')
  async updateFeed(@Param('id') id: string, @Body() body: unknown): Promise<CalendarFeedDto> {
    const req = updateCalendarFeedRequestSchema.parse(body);
    if (req.url !== undefined) {
      const test = await this.icsProvider.testConnection(req.url);
      if (!test.ok) {
        throw new BadRequestException(`feed test failed: ${test.error}`);
      }
    }
    const feed = await this.feeds.update(id, req);
    if (feed.enabled) this.fireAndForgetSync('post-update');
    return this.feeds.toDto(feed);
  }

  @Delete('feeds/:id')
  @HttpCode(204)
  async deleteFeed(@Param('id') id: string): Promise<void> {
    await this.feeds.remove(id);
  }

  @Post('feeds/test')
  async testFeed(@Body() body: unknown): Promise<CalendarFeedTestResponse> {
    const req = calendarFeedTestRequestSchema.parse(body);
    return this.icsProvider.testConnection(req.url);
  }

  @Post('sync')
  async syncNow(): Promise<CalendarSyncNowResponse> {
    // Fire-and-forget: a sync over many feeds can take a while.
    const state: CalendarSyncNowResponse = this.sync.isRunning
      ? { started: false, alreadyRunning: true }
      : { started: true, alreadyRunning: false };
    this.fireAndForgetSync('manual');
    return state;
  }

  @Get('events')
  async listEvents(@Query() query: unknown): Promise<CalendarEventsResponse> {
    const range = calendarRangeQuerySchema.parse(query);
    return { events: await this.events.eventsInRange(range.from, range.to) };
  }

  @Get('events/:id')
  async eventDetail(@Param('id') id: string): Promise<CalendarEventDetailDto> {
    return this.events.eventDetail(id);
  }

  @Get('recordings')
  async listRecordings(@Query() query: unknown): Promise<CalendarRecordingsResponse> {
    const range = calendarRangeQuerySchema.parse(query);
    return { recordings: await this.events.recordingsInRange(range.from, range.to) };
  }

  @Get('items/:inboxItemId/events')
  async itemEvents(@Param('inboxItemId') inboxItemId: string): Promise<ItemEventsResponse> {
    return { events: await this.events.eventsForItem(inboxItemId) };
  }

  @Post('links')
  async createLink(@Body() body: unknown): Promise<LinkResponse> {
    const req = createLinkRequestSchema.parse(body);
    const link = await this.links.link(req.inboxItemId, req.eventId);
    return { inboxItemId: link.inboxItemId, eventId: link.calendarEventId, origin: link.origin };
  }

  @Delete('links/:inboxItemId/:eventId')
  @HttpCode(204)
  async deleteLink(
    @Param('inboxItemId') inboxItemId: string,
    @Param('eventId') eventId: string,
  ): Promise<void> {
    await this.links.unlink(inboxItemId, eventId);
  }

  private fireAndForgetSync(trigger: string): void {
    void this.sync
      .syncNow()
      .catch((err: unknown) =>
        this.logger.error(
          `${trigger} calendar sync failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }
}
