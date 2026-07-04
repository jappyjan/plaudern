import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PersistenceModule } from '@plaudern/persistence';
import { CALENDAR_PROVIDERS } from './provider';
import { CALENDAR_FETCH, IcsFeedClient, type FetchLike } from './ics/ics-feed.client';
import { IcsCalendarProvider } from './ics/ics-calendar.provider';
import { GoogleCalendarClient, GOOGLE_OAUTH_CONFIG } from './google/google-calendar.client';
import { GoogleCalendarProvider } from './google/google-calendar.provider';
import { GoogleOAuthService } from './google/google-oauth.service';
import { CalendarFeedsService } from './calendar-feeds.service';
import { CalendarLinkService } from './calendar-link.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarSyncScheduler } from './calendar-sync.scheduler';
import { CalendarController } from './calendar.controller';

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot(), PersistenceModule],
  providers: [
    {
      // Registered explicitly so tests can overrideProvider() with a fake.
      provide: CALENDAR_FETCH,
      useValue: ((url, init) => fetch(url, init)) satisfies FetchLike,
    },
    IcsFeedClient,
    IcsCalendarProvider,
    {
      provide: GOOGLE_OAUTH_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        clientId: config.get<string>('GOOGLE_OAUTH_CLIENT_ID', ''),
        clientSecret: config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET', ''),
        redirectUri: config.get<string>('GOOGLE_OAUTH_REDIRECT_URI', ''),
        appBaseUrl: config.get<string>('GOOGLE_APP_BASE_URL', ''),
      }),
    },
    GoogleCalendarClient,
    GoogleCalendarProvider,
    GoogleOAuthService,
    {
      provide: CALENDAR_PROVIDERS,
      useFactory: (ics: IcsCalendarProvider, google: GoogleCalendarProvider) => [ics, google],
      inject: [IcsCalendarProvider, GoogleCalendarProvider],
    },
    CalendarFeedsService,
    CalendarLinkService,
    CalendarSyncService,
    CalendarEventsService,
    CalendarSyncScheduler,
  ],
  controllers: [CalendarController],
  exports: [CalendarFeedsService, CalendarSyncService, CalendarEventsService, CalendarLinkService],
})
export class CalendarModule {}
