import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import type { CalendarEventDto, InboxItemDto } from '@plaudern/contracts';
import { Link, useParams } from 'react-router-dom';
import {
  deleteCalendarLink,
  getItem,
  getSourceUrl,
  listItemEvents,
  retryTranscription,
} from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { usePlaceName } from '../hooks/usePlaceName';
import { latestTranscription, TranscriptionChip } from '../components/TranscriptionChip';
import { LinkEventModal } from '../components/calendar/LinkEventModal';
import { SpeakerTranscript } from '../components/SpeakerTranscript';
import { BackIcon, CalendarIcon, LinkIcon, LocationIcon, UnlinkIcon } from '../components/icons';
import { formatBytes, formatDate, formatDateTime, formatTimeRange } from '../lib/format';
import type { GeoLocation } from '../lib/geolocation';

// SSE delivers updates instantly; polling is only a fallback for proxies
// that break the event stream, so it can be slow.
const POLL_INTERVAL_MS = 10_000;

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [item, setItem] = useState<InboxItemDto | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [confirmRerunOpen, setConfirmRerunOpen] = useState(false);
  const [linkedEvents, setLinkedEvents] = useState<CalendarEventDto[] | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const refetch = useCallback(() => {
    if (!id) return;
    getItem(id)
      .then(setItem)
      .catch(() => undefined);
  }, [id]);

  const retry = useCallback(async () => {
    if (!id) return;
    setRetrying(true);
    setRetryError(null);
    try {
      setItem(await retryTranscription(id));
      setConfirmRerunOpen(false);
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  }, [id]);

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

  // Extracted before the early returns below because usePlaceName is a hook.
  const location = item?.metadata?.location as (GeoLocation & { alt?: number }) | undefined;
  const { label: placeName } = usePlaceName(location);

  // Live transcription progress via SSE (polling below is only a fallback).
  useInboxEvents({
    onEvent: (event) => {
      if (event.type !== 'heartbeat' && event.itemId === id) refetch();
    },
    onReconnect: refetch,
  });

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
            <SpeakerTranscript itemId={item.id} transcription={transcription} />
          )}
          {transcription?.status === 'failed' && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-danger">{transcription.error ?? 'Transcription failed.'}</p>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                className="self-start"
                isLoading={retrying}
                onPress={retry}
              >
                Retry transcription
              </Button>
              {retryError && <p className="text-xs text-danger">{retryError}</p>}
            </div>
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
              <div className="flex flex-col items-end">
                <a
                  href={`https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}#map=16/${location.lat}/${location.lon}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-right text-primary"
                  title={`${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}
                >
                  <LocationIcon className="h-4 w-4 shrink-0" />
                  {placeName ?? `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}
                </a>
                {placeName && (
                  <span className="text-xs text-default-400">
                    {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
                  </span>
                )}
              </div>
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

      {transcription?.status === 'succeeded' && (
        <>
          <Accordion isCompact>
            <AccordionItem
              key="advanced"
              aria-label="Advanced"
              title={<span className="text-sm font-semibold">Advanced</span>}
            >
              <div className="flex flex-col gap-2 rounded-medium border border-danger-200 bg-danger-50 p-3">
                <p className="text-sm text-danger">
                  Re-running transcription will replace the current transcript.
                </p>
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  className="self-start"
                  onPress={() => {
                    setRetryError(null);
                    setConfirmRerunOpen(true);
                  }}
                >
                  Re-run transcription
                </Button>
              </div>
            </AccordionItem>
          </Accordion>

          <Modal isOpen={confirmRerunOpen} onClose={() => !retrying && setConfirmRerunOpen(false)}>
            <ModalContent>
              <ModalHeader>Re-run transcription?</ModalHeader>
              <ModalBody>
                <p className="text-sm">
                  The existing transcript will be overwritten by the new result. This cannot be
                  undone.
                </p>
                {retryError && <p className="text-xs text-danger">{retryError}</p>}
              </ModalBody>
              <ModalFooter>
                <Button
                  variant="light"
                  isDisabled={retrying}
                  onPress={() => setConfirmRerunOpen(false)}
                >
                  Cancel
                </Button>
                <Button color="danger" isLoading={retrying} onPress={retry}>
                  Overwrite and re-run
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>
        </>
      )}
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
