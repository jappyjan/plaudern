import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Spinner,
  Tab,
  Tabs,
} from '@heroui/react';
import type { CalendarEventDto, InboxItemDto } from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteCalendarLink,
  deleteInboxItem,
  getItem,
  getSourceUrl,
  listItemEvents,
  reprocessItem,
  retryDiarization,
  retrySummary,
  retryTranscription,
  splitItem,
} from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { usePlaceName } from '../hooks/usePlaceName';
import { AudioPlayer } from '../components/AudioPlayer';
import { latestTranscription, TranscriptionChip } from '../components/TranscriptionChip';
import { LinkEventModal } from '../components/calendar/LinkEventModal';
import { SpeakerTranscript } from '../components/SpeakerTranscript';
import { SummaryView } from '../components/SummaryView';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import {
  BackIcon,
  CalendarIcon,
  LinkIcon,
  LocationIcon,
  TrashIcon,
  UnlinkIcon,
} from '../components/icons';
import { formatBytes, formatDate, formatDateTime, formatTimeRange } from '../lib/format';
import type { GeoLocation } from '../lib/geolocation';

// SSE delivers updates instantly; polling is only a fallback for proxies
// that break the event stream, so it can be slow.
const POLL_INTERVAL_MS = 10_000;

type ReprocessStep = 'transcription' | 'diarization' | 'summary' | 'all';

/**
 * The individually re-runnable pipeline steps, shown in the Reprocess panel.
 * `all` replays transcription + diarization (the summary then follows via the
 * server-side trigger); the single-step actions target one stage only. Every
 * run appends a new extraction — the immutable history is never overwritten.
 */
const REPROCESS_STEPS: {
  key: ReprocessStep;
  label: string;
  description: string;
  action: string;
  run: (id: string) => Promise<InboxItemDto | void>;
}[] = [
  {
    key: 'transcription',
    label: 'Transcription',
    description: 'Re-transcribe the audio.',
    action: 'Re-transcribe',
    run: (id) => retryTranscription(id),
  },
  {
    key: 'diarization',
    label: 'Speaker identification',
    description: 'Re-run diarization and voice matching.',
    action: 'Re-identify',
    run: (id) => retryDiarization(id),
  },
  {
    key: 'summary',
    label: 'Summary',
    description: 'Regenerate the AI title and summary.',
    action: 'Regenerate',
    run: async (id) => {
      await retrySummary(id);
    },
  },
  {
    key: 'all',
    label: 'Whole pipeline',
    description: 'Re-run transcription and speaker identification (the summary follows).',
    action: 'Reprocess all',
    run: (id) => reprocessItem(id),
  },
];

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<InboxItemDto | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which reprocess step is currently running (null = none) and its last error.
  const [busyStep, setBusyStep] = useState<ReprocessStep | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [linkedEvents, setLinkedEvents] = useState<CalendarEventDto[] | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  // Which tab is shown; defaults to the summary once one exists, else the
  // transcript. Null until the item loads so we can pick the default; a manual
  // switch afterwards sticks (SSE refetches never override it).
  const [tab, setTab] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!id) return;
    getItem(id)
      .then(setItem)
      .catch(() => undefined);
  }, [id]);

  // Run one reprocess step. Actions that return the refreshed item update it in
  // place; the summary retry (which returns a summary) triggers a refetch. SSE
  // then keeps the item live as the appended extractions progress.
  const runStep = useCallback(
    async (step: ReprocessStep, action: () => Promise<InboxItemDto | void>) => {
      setBusyStep(step);
      setStepError(null);
      try {
        const updated = await action();
        if (updated) setItem(updated);
        else refetch();
      } catch (cause) {
        setStepError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyStep(null);
      }
    },
    [refetch],
  );

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

  // Pick the initial tab once the item is known: prefer the summary when it's
  // ready, otherwise start on the transcript.
  useEffect(() => {
    if (!item || tab !== null) return;
    const summary = item.extractions.find((e) => e.kind === 'summary');
    setTab(summary?.status === 'succeeded' ? 'summary' : 'transcript');
  }, [item, tab]);

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
      if (event.type === 'heartbeat' || event.itemId !== id) return;
      // Deleted from another tab: leave instead of refetching into a 404.
      if (event.type === 'item.deleted') {
        navigate('/');
        return;
      }
      refetch();
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

  const confirmDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteInboxItem(id);
      navigate('/');
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  };

  const mergedFromCount = item.mergedFromItemIds?.length ?? 0;

  const confirmSplit = async () => {
    if (!id) return;
    setSplitting(true);
    setSplitError(null);
    try {
      await splitItem(id);
      navigate('/');
    } catch (cause) {
      setSplitError(cause instanceof Error ? cause.message : String(cause));
      setSplitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <BackLink />
        <div className="flex items-center gap-1">
          {mergedFromCount > 0 && (
            <Button
              variant="light"
              size="sm"
              startContent={<UnlinkIcon className="h-4 w-4" />}
              onPress={() => setSplitOpen(true)}
            >
              Split
            </Button>
          )}
          <Button
            color="danger"
            variant="light"
            size="sm"
            startContent={<TrashIcon className="h-4 w-4" />}
            onPress={() => setConfirmOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {sourceUrl && item.sourceType !== 'text' && item.sourceType !== 'web' && (
        <Card>
          <CardBody>
            {/* Presigned GET straight from object storage. */}
            <AudioPlayer src={sourceUrl} className="w-full" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <Tabs
            aria-label="Recording views"
            variant="underlined"
            selectedKey={tab ?? 'transcript'}
            onSelectionChange={(key) => setTab(String(key))}
          >
            <Tab key="summary" title="Summary">
              <div className="pt-2">
                <SummaryView itemId={item.id} />
              </div>
            </Tab>
            <Tab
              key="transcript"
              title={
                <div className="flex items-center gap-2">
                  <span>Transcript</span>
                  <TranscriptionChip item={item} />
                </div>
              }
            >
              <div className="flex flex-col gap-2 pt-2">
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
                    <p className="text-sm text-danger">
                      {transcription.error ?? 'Transcription failed.'}
                    </p>
                    <Button
                      size="sm"
                      color="primary"
                      variant="flat"
                      className="self-start"
                      isLoading={busyStep === 'transcription'}
                      isDisabled={busyStep !== null}
                      onPress={() => id && runStep('transcription', () => retryTranscription(id))}
                    >
                      Retry transcription
                    </Button>
                    {stepError && busyStep === null && (
                      <p className="text-xs text-danger">{stepError}</p>
                    )}
                  </div>
                )}
              </div>
            </Tab>
          </Tabs>
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
          {mergedFromCount > 0 && (
            <DetailRow label="Merged from" value={`${mergedFromCount} recordings`} />
          )}
          {item.source?.originalFilename && (
            <DetailRow label="File" value={item.source.originalFilename} />
          )}
          {typeof item.metadata?.url === 'string' && (
            <div className="flex items-start justify-between gap-4">
              <span className="text-default-500">Source page</span>
              <a
                href={item.metadata.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1 text-primary"
              >
                <LinkIcon className="h-4 w-4 shrink-0" />
                <span className="truncate break-all">{item.metadata.url}</span>
              </a>
            </div>
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

      {transcription?.status === 'succeeded' && id && (
        <Accordion isCompact>
          <AccordionItem
            key="advanced"
            aria-label="Reprocess"
            title={<span className="text-sm font-semibold">Reprocess</span>}
          >
            <div className="flex flex-col gap-3">
              <p className="text-xs text-default-500">
                Re-run a single step or the whole pipeline. Each run appends a new result and
                replaces what's shown; earlier attempts stay in the history. Later steps re-run
                automatically after an earlier one finishes.
              </p>
              {REPROCESS_STEPS.map((step) => (
                <div
                  key={step.key}
                  className="flex items-center justify-between gap-3 rounded-medium bg-default-50 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{step.label}</p>
                    <p className="text-xs text-default-500">{step.description}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="flat"
                    color={step.key === 'all' ? 'danger' : 'primary'}
                    className="shrink-0"
                    isLoading={busyStep === step.key}
                    isDisabled={busyStep !== null}
                    onPress={() => runStep(step.key, () => step.run(id))}
                  >
                    {step.action}
                  </Button>
                </div>
              ))}
              {stepError && busyStep === null && (
                <p className="text-xs text-danger">{stepError}</p>
              )}
            </div>
          </AccordionItem>
        </Accordion>
      )}

      <ConfirmDeleteModal
        isOpen={confirmOpen}
        isDeleting={deleting}
        error={deleteError}
        message={
          mergedFromCount > 0
            ? `This deletes the merged recording and restores the ${mergedFromCount} original recordings it was combined from.`
            : undefined
        }
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setConfirmOpen(false);
          setDeleteError(null);
        }}
      />

      <ConfirmDeleteModal
        isOpen={splitOpen}
        isDeleting={splitting}
        error={splitError}
        title="Split merged recording?"
        message={`This restores the ${mergedFromCount} original recordings and deletes this merged one (including its transcript and summary).`}
        confirmLabel="Split"
        onConfirm={() => void confirmSplit()}
        onClose={() => {
          setSplitOpen(false);
          setSplitError(null);
        }}
      />
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
