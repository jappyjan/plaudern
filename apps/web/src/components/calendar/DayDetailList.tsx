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

export function DayDetailList({ dayLabel, events, recordings, onEventClick }: DayDetailListProps) {
  const sorted = [...events].sort((a, b) => {
    if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
    return a.startAt.localeCompare(b.startAt);
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{dayLabel}</h3>

      {sorted.length === 0 && recordings.length === 0 && (
        <p className="text-sm text-default-500">No events or recordings on this day.</p>
      )}

      {sorted.map((event) => (
        <Card key={event.id} isPressable onPress={() => onEventClick(event.id)}>
          <CardBody className="flex flex-row items-center gap-3 py-3">
            <span
              className="h-8 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: event.feedColor ?? 'hsl(var(--heroui-primary))' }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{event.title ?? '(untitled event)'}</p>
              <p className="text-xs text-default-500">
                {event.isAllDay ? 'All day' : formatTimeRange(event.startAt, event.endAt)}
                {event.location ? ` · ${event.location}` : ''}
              </p>
            </div>
            {event.linkedRecordingIds.length > 0 && (
              <Chip size="sm" variant="flat" color="success" startContent={<MicIcon className="h-3 w-3" />}>
                {event.linkedRecordingIds.length}
              </Chip>
            )}
          </CardBody>
        </Card>
      ))}

      {recordings.length > 0 && (
        <>
          <h4 className="pt-1 text-xs font-semibold uppercase text-default-500">Recordings</h4>
          {recordings.map((recording) => (
            <Card key={recording.id} isPressable as={Link} to={`/items/${recording.id}`}>
              <CardBody className="flex flex-row items-center gap-3 py-3">
                <AudioIcon className="h-5 w-5 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {recording.originalFilename ?? `${recording.sourceType} capture`}
                  </p>
                  <p className="text-xs text-default-500">
                    {formatTime(recording.occurredAt)}
                    {recording.durationMs !== null
                      ? ` · ${Math.round(recording.durationMs / 60000)} min`
                      : ''}
                  </p>
                </div>
                {recording.linkedEventIds.length > 0 && (
                  <Chip size="sm" variant="flat">
                    {recording.linkedEventIds.length} event{recording.linkedEventIds.length === 1 ? '' : 's'}
                  </Chip>
                )}
              </CardBody>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
