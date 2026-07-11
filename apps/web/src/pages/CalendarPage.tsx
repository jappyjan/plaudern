import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@heroui/react';
import type { CalendarEventDto, RecordingSummaryDto, ReminderDto } from '@plaudern/contracts';
import { Link, useSearchParams } from 'react-router-dom';
import {
  listCalendarEvents,
  listCalendarRecordings,
  listReminders,
  updateReminderStatus,
} from '../lib/api';
import { localDayKey, monthGridDays, utcDayKey } from '../lib/format';
import { MonthGrid, type DayMarkers } from '../components/calendar/MonthGrid';
import { DayDetailList } from '../components/calendar/DayDetailList';
import { ReminderList } from '../components/calendar/ReminderList';
import { EventDetailModal } from '../components/calendar/EventDetailModal';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DayBucket {
  events: CalendarEventDto[];
  recordings: RecordingSummaryDto[];
  reminders: ReminderDto[];
}

/**
 * Buckets by day key. Timed events and recordings land on browser-local days
 * (the day the user experienced them); all-day events land on the UTC
 * calendar dates they were stored as. Multi-day events appear on every day
 * they cover.
 */
function buildBuckets(
  events: CalendarEventDto[],
  recordings: RecordingSummaryDto[],
  reminders: ReminderDto[],
): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  const bucket = (key: string): DayBucket => {
    let entry = buckets.get(key);
    if (!entry) {
      entry = { events: [], recordings: [], reminders: [] };
      buckets.set(key, entry);
    }
    return entry;
  };

  for (const event of events) {
    const keys = new Set<string>();
    if (event.isAllDay) {
      // endAt is exclusive; walk the stored UTC dates.
      for (
        let ts = Date.parse(event.startAt), guard = 0;
        ts < Date.parse(event.endAt) && guard < 62;
        ts += DAY_MS, guard += 1
      ) {
        keys.add(utcDayKey(new Date(ts).toISOString()));
      }
      if (keys.size === 0) keys.add(utcDayKey(event.startAt));
    } else {
      for (
        let ts = Date.parse(event.startAt), guard = 0;
        ts <= Date.parse(event.endAt) && guard < 62;
        ts += DAY_MS, guard += 1
      ) {
        keys.add(localDayKey(new Date(ts).toISOString()));
      }
      keys.add(localDayKey(event.endAt));
    }
    for (const key of keys) bucket(key).events.push(event);
  }

  for (const recording of recordings) {
    // A scanned document's own date is a UTC calendar date (midnight-anchored),
    // so it buckets by its UTC day like an all-day event; a plain recording is a
    // real instant that buckets by the browser-local day it happened.
    const key = recording.documentDate
      ? utcDayKey(recording.documentDate)
      : localDayKey(recording.occurredAt);
    bucket(key).recordings.push(recording);
  }

  // Reminders land on the browser-local day their resolved due instant falls on.
  for (const reminder of reminders) {
    bucket(localDayKey(reminder.dueAt)).reminders.push(reminder);
  }
  return buckets;
}

export function CalendarPage() {
  const today = new Date();
  const todayKey = localDayKey(today.toISOString());
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [events, setEvents] = useState<CalendarEventDto[] | null>(null);
  const [recordings, setRecordings] = useState<RecordingSummaryDto[]>([]);
  const [reminders, setReminders] = useState<ReminderDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get('event');

  const refresh = useCallback(async () => {
    try {
      // Fetch the full visible 42-day grid (plus a day of slack on each side
      // for timezone spill-over).
      const days = monthGridDays(year, month);
      const from = new Date(days[0].date.getTime() - DAY_MS).toISOString();
      const to = new Date(days[days.length - 1].date.getTime() + 2 * DAY_MS).toISOString();
      const [eventsRes, recordingsRes, remindersRes] = await Promise.all([
        listCalendarEvents(from, to),
        listCalendarRecordings(from, to),
        listReminders({ from, to }),
      ]);
      setEvents(eventsRes.events);
      setRecordings(recordingsRes.recordings);
      setReminders(remindersRes.reminders);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [year, month]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buckets = useMemo(
    () => buildBuckets(events ?? [], recordings, reminders),
    [events, recordings, reminders],
  );
  const markers = useMemo(() => {
    const map = new Map<string, DayMarkers>();
    for (const [key, value] of buckets) {
      map.set(key, {
        hasEvents: value.events.length > 0,
        hasRecordings: value.recordings.length > 0,
        hasReminders: value.reminders.length > 0,
      });
    }
    return map;
  }, [buckets]);

  const updateReminder = useCallback(
    async (id: string, status: 'done' | 'dismissed' | 'active') => {
      try {
        await updateReminderStatus(id, status);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [refresh],
  );

  const selected = buckets.get(selectedKey) ?? { events: [], recordings: [], reminders: [] };
  const selectedLabel = new Date(`${selectedKey}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const shiftMonth = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to load calendar: {error}
        </div>
      )}

      <MonthGrid
        year={year}
        month={month}
        markers={markers}
        selectedKey={selectedKey}
        todayKey={todayKey}
        onSelect={setSelectedKey}
        onPrevMonth={() => shiftMonth(-1)}
        onNextMonth={() => shiftMonth(1)}
        onToday={() => {
          setYear(today.getFullYear());
          setMonth(today.getMonth());
          setSelectedKey(todayKey);
        }}
      />

      {events === null && !error ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading calendar…" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <DayDetailList
            dayLabel={selectedLabel}
            events={selected.events}
            recordings={selected.recordings}
            onEventClick={(id) => setSearchParams({ event: id })}
          />
          <ReminderList reminders={selected.reminders} onUpdate={updateReminder} />
        </div>
      )}

      {events !== null &&
        events.length === 0 &&
        recordings.length === 0 &&
        reminders.length === 0 &&
        !error && (
          <p className="text-sm text-default-500">
            Nothing on the calendar yet — subscribe to a calendar feed in{' '}
            <Link to="/settings" className="text-primary">
              settings
            </Link>
            .
          </p>
        )}

      <EventDetailModal
        eventId={eventId}
        onClose={() => setSearchParams({})}
        onLinksChanged={() => void refresh()}
      />
    </div>
  );
}
