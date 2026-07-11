import { Chip } from '@heroui/react';
import type { CalendarEventDto, RecordingSummaryDto } from '@plaudern/contracts';
import { formatDate, formatTime, formatTimeRange, itemDate } from '../../lib/format';
import { MicIcon, SourceIcon } from '../icons';
import { DocumentRow } from '../DocumentRow';

interface DayDetailListProps {
  dayLabel: string;
  events: CalendarEventDto[];
  recordings: RecordingSummaryDto[];
  onEventClick: (eventId: string) => void;
}

/** An event or recording, unified so the day reads as one timeline. */
type TimelineEntry =
  | { kind: 'event'; startAt: string; allDay: boolean; event: CalendarEventDto }
  | { kind: 'recording'; startAt: string; allDay: false; recording: RecordingSummaryDto };

/**
 * Single chronological list: all-day events first, then events and
 * recordings interleaved by start time — a recording made during a meeting
 * shows up right next to it.
 */
export function DayDetailList({ dayLabel, events, recordings, onEventClick }: DayDetailListProps) {
  const entries: TimelineEntry[] = [
    ...events.map(
      (event): TimelineEntry => ({
        kind: 'event',
        startAt: event.startAt,
        allDay: event.isAllDay,
        event,
      }),
    ),
    ...recordings.map(
      (recording): TimelineEntry => ({
        kind: 'recording',
        // Sort by the same date the row is bucketed under (detected doc date
        // when present, else capture time).
        startAt: itemDate(recording),
        allDay: false,
        recording,
      }),
    ),
  ].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.startAt.localeCompare(b.startAt);
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{dayLabel}</h3>

      {entries.length === 0 && (
        <p className="text-sm text-default-500">No events or recordings on this day.</p>
      )}

      {entries.map((entry) =>
        entry.kind === 'event' ? (
          <DocumentRow
            key={`event-${entry.event.id}`}
            variant="card"
            onPress={() => onEventClick(entry.event.id)}
            leading={
              <span
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ backgroundColor: entry.event.feedColor ?? 'hsl(var(--heroui-primary))' }}
              />
            }
            title={entry.event.title ?? '(untitled event)'}
            subtitle={
              <>
                {entry.event.isAllDay
                  ? 'All day'
                  : formatTimeRange(entry.event.startAt, entry.event.endAt)}
                {entry.event.location ? ` · ${entry.event.location}` : ''}
              </>
            }
            trailing={
              entry.event.linkedRecordingIds.length > 0 && (
                <Chip
                  size="sm"
                  variant="flat"
                  color="success"
                  startContent={<MicIcon className="h-3 w-3" />}
                >
                  {entry.event.linkedRecordingIds.length}
                </Chip>
              )
            }
          />
        ) : (
          <DocumentRow
            key={`recording-${entry.recording.id}`}
            variant="card"
            to={`/items/${entry.recording.id}`}
            leading={
              <SourceIcon
                sourceType={entry.recording.sourceType}
                className="h-5 w-5 shrink-0 text-success"
              />
            }
            title={
              entry.recording.title ??
              entry.recording.originalFilename ??
              `${entry.recording.sourceType} capture`
            }
            subtitle={
              <>
                {entry.recording.documentDate
                  ? `Dated ${formatDate(entry.recording.documentDate)}`
                  : `Recording · ${formatTime(entry.recording.occurredAt)}`}
                {entry.recording.durationMs !== null
                  ? ` · ${Math.round(entry.recording.durationMs / 60000)} min`
                  : ''}
              </>
            }
            trailing={
              entry.recording.linkedEventIds.length > 0 && (
                <Chip size="sm" variant="flat">
                  {entry.recording.linkedEventIds.length} event
                  {entry.recording.linkedEventIds.length === 1 ? '' : 's'}
                </Chip>
              )
            }
          />
        ),
      )}
    </div>
  );
}
