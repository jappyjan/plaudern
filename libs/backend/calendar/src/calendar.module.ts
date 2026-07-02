import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PersistenceModule } from '@plaudern/persistence';
import { CALENDAR_PROVIDERS } from './provider';
import { CALENDAR_FETCH, IcsFeedClient, type FetchLike } from './ics/ics-feed.client';
import { IcsCalendarProvider } from './ics/ics-calendar.provider';
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
      // Future OAuth providers (google, …) get appended here.
      provide: CALENDAR_PROVIDERS,
      useFactory: (ics: IcsCalendarProvider) => [ics],
      inject: [IcsCalendarProvider],
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
