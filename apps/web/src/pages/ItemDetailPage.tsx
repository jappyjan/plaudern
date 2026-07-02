import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type { CalendarEventDto, InboxItemDto } from '@plaudern/contracts';
import { Link, useParams } from 'react-router-dom';
import { deleteCalendarLink, getItem, getSourceUrl, listItemEvents } from '../lib/api';
import { latestTranscription, TranscriptionChip } from '../components/TranscriptionChip';
import { LinkEventModal } from '../components/calendar/LinkEventModal';
import { BackIcon, CalendarIcon, LinkIcon, LocationIcon, UnlinkIcon } from '../components/icons';
import { formatBytes, formatDate, formatDateTime, formatTimeRange } from '../lib/format';
import type { GeoLocation } from '../lib/geolocation';

const POLL_INTERVAL_MS = 3000;

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<InboxItemDto | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkedEvents, setLinkedEvents] = useState<CalendarEventDto[] | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const refreshEvents = useCallback(async () => {
    if (!id) return;
    try {
      setLinkedEvents((await listItemEvents(id)).events);
    } catch {
      // Calendar module errors must not break the item page.
      setLinkedEvents([]);
    }
  }, [id]);

  useEffect(() => {
    void refreshEvents();
  }, [refreshEvents]);

  const unlinkEvent = async (eventId: string) => {
    if (!id) return;
    try {
      await deleteCalendarLink(id, eventId);
      await refreshEvents();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const fetched = await getItem(id);
        if (cancelled) return;
        setItem(fetched);
        // Keep polling while a transcription is still in flight.
        const transcription = latestTranscription(fetched);
        if (transcription && ['queued', 'processing'].includes(transcription.status)) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void load();
    getSourceUrl(id)
      .then((url) => {
        if (!cancelled) setSourceUrl(url);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const transcription = latestTranscription(item);
  const location = item.metadata?.location as (GeoLocation & { alt?: number }) | undefined;
  const device = item.metadata?.device as Record<string, string> | undefined;
  const tags = item.metadata?.tags as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      {sourceUrl && item.sourceType !== 'text' && (
        <Card>
          <CardBody>
            {/* Presigned GET straight from object storage. */}
            <audio controls src={sourceUrl} className="w-full" preload="metadata" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between pb-0">
          <h2 className="text-sm font-semibold">Transcription</h2>
          <TranscriptionChip item={item} />
        </CardHeader>
        <CardBody>
          {!transcription && (
            <p className="text-sm text-default-500">No transcription for this item.</p>
          )}
          {transcription && ['queued', 'processing'].includes(transcription.status) && (
            <div className="flex items-center gap-2 text-sm text-default-500">
              <Spinner size="sm" /> Transcribing…
            </div>
          )}
          {transcription?.status === 'succeeded' && (
            <p className="whitespace-pre-wrap text-sm">{transcription.content}</p>
          )}
          {transcription?.status === 'failed' && (
            <p className="text-sm text-danger">{transcription.error ?? 'Transcription failed.'}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between pb-0">
          <h2 className="text-sm font-semibold">Calendar events</h2>
          <Button
            size="sm"
            variant="flat"
            startContent={<LinkIcon className="h-3.5 w-3.5" />}
            onPress={() => setLinkPickerOpen(true)}
          >
            Link to event
          </Button>
        </CardHeader>
        <CardBody className="gap-2 text-sm">
          {linkedEvents === null && (
            <div className="flex items-center gap-2 text-default-500">
              <Spinner size="sm" /> Loading…
            </div>
          )}
          {linkedEvents?.length === 0 && (
            <p className="text-default-500">No linked calendar events.</p>
          )}
          {linkedEvents?.map((event) => (
            <div key={event.id} className="flex items-center gap-3 rounded-medium bg-default-50 p-2">
              <CalendarIcon className="h-4 w-4 shrink-0 text-primary" />
              <Link
                to={`/calendar?event=${event.id}`}
                className="min-w-0 flex-1 text-primary"
              >
                <span className="block truncate">{event.title ?? '(untitled event)'}</span>
                <span className="block text-xs text-default-500">
                  {event.isAllDay
                    ? `All day · ${formatDate(event.startAt)}`
                    : `${formatDate(event.startAt)} · ${formatTimeRange(event.startAt, event.endAt)}`}
                  {' · '}
                  {event.feedName}
                </span>
              </Link>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="Unlink event"
                onPress={() => void unlinkEvent(event.id)}
              >
                <UnlinkIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>

      <LinkEventModal
        isOpen={linkPickerOpen}
        inboxItemId={item.id}
        occurredAt={item.occurredAt}
        alreadyLinkedIds={(linkedEvents ?? []).map((event) => event.id)}
        onClose={() => setLinkPickerOpen(false)}
        onLinked={() => void refreshEvents()}
      />

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-sm font-semibold">Details</h2>
        </CardHeader>
        <CardBody className="gap-2 text-sm">
          <DetailRow label="Recorded" value={formatDateTime(item.occurredAt)} />
          <DetailRow label="Added to inbox" value={formatDateTime(item.ingestedAt)} />
          {item.source?.originalFilename && (
            <DetailRow label="File" value={item.source.originalFilename} />
          )}
          {item.source && <DetailRow label="Type" value={item.source.contentType} />}
          {item.source && item.source.byteSize > 0 && (
            <DetailRow label="Size" value={formatBytes(item.source.byteSize)} />
          )}
          {device && Object.keys(device).length > 0 && (
            <DetailRow
              label="Device"
              value={[device.make, device.model, device.software ?? device.encoder]
                .filter(Boolean)
                .join(' · ') || device.userAgent || ''}
            />
          )}
          {location && (
            <div className="flex items-start justify-between gap-4">
              <span className="text-default-500">Location</span>
              <a
                href={`https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}#map=16/${location.lat}/${location.lon}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary"
              >
                <LocationIcon className="h-4 w-4" />
                {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
              </a>
            </div>
          )}
          {tags && Object.keys(tags).length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {Object.entries(tags)
                .filter(([key]) => key !== 'durationSeconds')
                .map(([key, value]) => (
                  <Chip key={key} size="sm" variant="flat">
                    {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                  </Chip>
                ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Button
      as={Link}
      to="/"
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      Inbox
    </Button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-default-500">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  );
}
