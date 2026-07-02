import { Card, CardBody, Chip } from '@heroui/react';
import type { CalendarEventDto, RecordingSummaryDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { formatTime, formatTimeRange } from '../../lib/format';
import { AudioIcon, MicIcon } from '../icons';

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
        startAt: recording.occurredAt,
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
          <Card key={`event-${entry.event.id}`} isPressable onPress={() => onEventClick(entry.event.id)}>
            <CardBody className="flex flex-row items-center gap-3 py-3">
              <span
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ backgroundColor: entry.event.feedColor ?? 'hsl(var(--heroui-primary))' }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {entry.event.title ?? '(untitled event)'}
                </p>
                <p className="text-xs text-default-500">
                  {entry.event.isAllDay
                    ? 'All day'
                    : formatTimeRange(entry.event.startAt, entry.event.endAt)}
                  {entry.event.location ? ` · ${entry.event.location}` : ''}
                </p>
              </div>
              {entry.event.linkedRecordingIds.length > 0 && (
                <Chip
                  size="sm"
                  variant="flat"
                  color="success"
                  startContent={<MicIcon className="h-3 w-3" />}
                >
                  {entry.event.linkedRecordingIds.length}
                </Chip>
              )}
            </CardBody>
          </Card>
        ) : (
          <Card key={`recording-${entry.recording.id}`} isPressable as={Link} to={`/items/${entry.recording.id}`}>
            <CardBody className="flex flex-row items-center gap-3 py-3">
              <AudioIcon className="h-5 w-5 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {entry.recording.originalFilename ?? `${entry.recording.sourceType} capture`}
                </p>
                <p className="text-xs text-default-500">
                  Recording · {formatTime(entry.recording.occurredAt)}
                  {entry.recording.durationMs !== null
                    ? ` · ${Math.round(entry.recording.durationMs / 60000)} min`
                    : ''}
                </p>
              </div>
              {entry.recording.linkedEventIds.length > 0 && (
                <Chip size="sm" variant="flat">
                  {entry.recording.linkedEventIds.length} event
                  {entry.recording.linkedEventIds.length === 1 ? '' : 's'}
                </Chip>
              )}
            </CardBody>
          </Card>
        ),
      )}
    </div>
  );
}
