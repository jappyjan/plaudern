import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type { InboxItemDto } from '@plaudern/contracts';
import { Link, useParams } from 'react-router-dom';
import { getItem, getSourceUrl, retryTranscription } from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { usePlaceName } from '../hooks/usePlaceName';
import { latestTranscription, TranscriptionChip } from '../components/TranscriptionChip';
import { BackIcon, LocationIcon } from '../components/icons';
import { formatBytes, formatDateTime } from '../lib/format';
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

  const refetch = useCallback(() => {
    if (!id) return;
    getItem(id)
      .then(setItem)
      .catch(() => undefined);
  }, [id]);

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
            <p className="whitespace-pre-wrap text-sm">{transcription.content}</p>
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
                onPress={async () => {
                  if (!id) return;
                  setRetrying(true);
                  setRetryError(null);
                  try {
                    setItem(await retryTranscription(id));
                  } catch (cause) {
                    setRetryError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                Retry transcription
              </Button>
              {retryError && <p className="text-xs text-danger">{retryError}</p>}
            </div>
          )}
        </CardBody>
      </Card>

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
