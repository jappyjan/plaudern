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
  Redirect,
  BadRequestException,
} from '@nestjs/common';
import {
  calendarFeedTestRequestSchema,
  calendarRangeQuerySchema,
  createCalendarFeedRequestSchema,
  createGoogleFeedsRequestSchema,
  createLinkRequestSchema,
  googleReconnectRequestSchema,
  updateCalendarFeedRequestSchema,
  type CalendarEventDetailDto,
  type CalendarEventsResponse,
  type CalendarFeedDto,
  type CalendarFeedsResponse,
  type CalendarFeedTestResponse,
  type CalendarRecordingsResponse,
  type CalendarSyncNowResponse,
  type GoogleAuthUrlResponse,
  type GooglePendingResponse,
  type ItemEventsResponse,
  type LinkResponse,
} from '@plaudern/contracts';
import { CurrentUser, Public, type AuthenticatedUser } from '@plaudern/auth';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarFeedsService } from './calendar-feeds.service';
import { CalendarLinkService } from './calendar-link.service';
import { CalendarSyncService } from './calendar-sync.service';
import { IcsCalendarProvider } from './ics/ics-calendar.provider';
import { GoogleOAuthService } from './google/google-oauth.service';

@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  private readonly logger = new Logger(CalendarController.name);

  constructor(
    private readonly feeds: CalendarFeedsService,
    private readonly events: CalendarEventsService,
    private readonly links: CalendarLinkService,
    private readonly sync: CalendarSyncService,
    private readonly icsProvider: IcsCalendarProvider,
    private readonly google: GoogleOAuthService,
  ) {}

  @Get('feeds')
  async listFeeds(@CurrentUser() user: AuthenticatedUser): Promise<CalendarFeedsResponse> {
    const feeds = await this.feeds.list(user.id);
    return {
      feeds: feeds.map((feed) => this.feeds.toDto(feed)),
      syncRunning: this.sync.isRunning,
      googleConfigured: this.google.isConfigured(),
    };
  }

  @Post('feeds')
  async createFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<CalendarFeedDto> {
    const req = createCalendarFeedRequestSchema.parse(body);
    // Prove the URL is fetchable and parseable before storing it.
    const test = await this.icsProvider.testConnection(req.url);
    if (!test.ok) {
      throw new BadRequestException(`feed test failed: ${test.error}`);
    }
    const feed = await this.feeds.create(user.id, req);
    this.fireAndForgetSync('post-create', user.id);
    return this.feeds.toDto(feed);
  }

  @Put('feeds/:id')
  async updateFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CalendarFeedDto> {
    const req = updateCalendarFeedRequestSchema.parse(body);
    if (req.url !== undefined) {
      const test = await this.icsProvider.testConnection(req.url);
      if (!test.ok) {
        throw new BadRequestException(`feed test failed: ${test.error}`);
      }
    }
    const feed = await this.feeds.update(user.id, id, req);
    if (feed.enabled) this.fireAndForgetSync('post-update', user.id);
    return this.feeds.toDto(feed);
  }

  @Delete('feeds/:id')
  @HttpCode(204)
  async deleteFeed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.feeds.remove(user.id, id);
  }

  @Post('feeds/test')
  async testFeed(@Body() body: unknown): Promise<CalendarFeedTestResponse> {
    const req = calendarFeedTestRequestSchema.parse(body);
    return this.icsProvider.testConnection(req.url);
  }

  @Post('sync')
  async syncNow(@CurrentUser() user: AuthenticatedUser): Promise<CalendarSyncNowResponse> {
    // Fire-and-forget: a sync over many feeds can take a while.
    const state: CalendarSyncNowResponse = this.sync.isRunning
      ? { started: false, alreadyRunning: true }
      : { started: true, alreadyRunning: false };
    this.fireAndForgetSync('manual', user.id);
    return state;
  }

  @Get('events')
  async listEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<CalendarEventsResponse> {
    const range = calendarRangeQuerySchema.parse(query);
    return { events: await this.events.eventsInRange(user.id, range.from, range.to) };
  }

  @Get('events/:id')
  async eventDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CalendarEventDetailDto> {
    return this.events.eventDetail(user.id, id);
  }

  @Get('recordings')
  async listRecordings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<CalendarRecordingsResponse> {
    const range = calendarRangeQuerySchema.parse(query);
    return { recordings: await this.events.recordingsInRange(user.id, range.from, range.to) };
  }

  @Get('items/:inboxItemId/events')
  async itemEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('inboxItemId') inboxItemId: string,
  ): Promise<ItemEventsResponse> {
    return { events: await this.events.eventsForItem(user.id, inboxItemId) };
  }

  @Post('links')
  async createLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<LinkResponse> {
    const req = createLinkRequestSchema.parse(body);
    const link = await this.links.link(user.id, req.inboxItemId, req.eventId);
    return { inboxItemId: link.inboxItemId, eventId: link.calendarEventId, origin: link.origin };
  }

  @Delete('links/:inboxItemId/:eventId')
  @HttpCode(204)
  async deleteLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('inboxItemId') inboxItemId: string,
    @Param('eventId') eventId: string,
  ): Promise<void> {
    await this.links.unlink(user.id, inboxItemId, eventId);
  }

  @Get('google/auth-url')
  googleAuthUrl(@CurrentUser() user: AuthenticatedUser): GoogleAuthUrlResponse {
    return { url: this.google.buildAuthUrl(user.id) };
  }

  // Public: this is the Google → browser OAuth redirect target. The user is
  // identified by the userId carried in the signed OAuth `state`, not a session.
  @Public()
  @Get('google/callback')
  @Redirect()
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
  ): Promise<{ url: string }> {
    if (!code || !state) throw new BadRequestException('missing code/state');
    const url = await this.google.handleCallback(code, state);
    return { url };
  }

  @Get('google/pending/:id')
  googlePending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): GooglePendingResponse {
    return this.google.getPending(user.id, id);
  }

  @Post('google/feeds')
  async googleCreateFeeds(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<CalendarFeedDto[]> {
    const req = createGoogleFeedsRequestSchema.parse(body);
    const feeds = await this.google.confirmFeeds(user.id, req.pendingId, req.calendarIds);
    this.fireAndForgetSync('post-google-connect', user.id);
    return feeds.map((feed) => this.feeds.toDto(feed));
  }

  @Post('google/reconnect')
  async googleReconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ updated: number }> {
    const req = googleReconnectRequestSchema.parse(body);
    const updated = await this.google.reconnect(user.id, req.pendingId);
    this.fireAndForgetSync('post-google-reconnect', user.id);
    return { updated };
  }

  private fireAndForgetSync(trigger: string, userId: string): void {
    void this.sync
      .syncNow(userId)
      .catch((err: unknown) =>
        this.logger.error(
          `${trigger} calendar sync failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }
}
