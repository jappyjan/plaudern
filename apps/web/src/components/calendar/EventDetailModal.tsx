import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import type { CalendarEventDetailDto, RecordingSummaryDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import {
  createCalendarLink,
  deleteCalendarLink,
  getCalendarEvent,
  listCalendarRecordings,
} from '../../lib/api';
import { formatDate, formatDateTime, formatTime, itemDate } from '../../lib/format';
import { AudioIcon, LinkIcon, UnlinkIcon } from '../icons';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Human label for a recording row — the good title, else the filename fallback. */
function recordingLabel(recording: RecordingSummaryDto): string {
  return recording.title ?? recording.originalFilename ?? `${recording.sourceType} capture`;
}

interface EventDetailModalProps {
  eventId: string | null;
  onClose: () => void;
  /** Called after any link change so the page behind can refresh. */
  onLinksChanged: () => void;
}

export function EventDetailModal({ eventId, onClose, onLinksChanged }: EventDetailModalProps) {
  const [event, setEvent] = useState<CalendarEventDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [candidates, setCandidates] = useState<RecordingSummaryDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!eventId) return;
    try {
      setEvent(await getCalendarEvent(eventId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [eventId]);

  useEffect(() => {
    setEvent(null);
    setError(null);
    setShowPicker(false);
    setCandidates(null);
    void refresh();
  }, [refresh]);

  const loadCandidates = async () => {
    if (!event) return;
    setShowPicker(true);
    try {
      const from = new Date(Date.parse(event.startAt) - DAY_MS).toISOString();
      const to = new Date(Date.parse(event.endAt) + DAY_MS).toISOString();
      const { recordings } = await listCalendarRecordings(from, to);
      const linked = new Set(event.recordings.map((recording) => recording.id));
      setCandidates(recordings.filter((recording) => !linked.has(recording.id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const link = async (recordingId: string) => {
    if (!event) return;
    setBusy(true);
    try {
      await createCalendarLink(recordingId, event.id);
      setShowPicker(false);
      await refresh();
      onLinksChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (recordingId: string) => {
    if (!event) return;
    setBusy(true);
    try {
      await deleteCalendarLink(recordingId, event.id);
      await refresh();
      onLinksChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={eventId !== null} onClose={onClose} scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {event ? (event.title ?? '(untitled event)') : 'Event'}
          {event && (
            <span className="text-xs font-normal text-default-500">
              {event.isAllDay
                ? `All day · ${formatDate(event.startAt)}`
                : `${formatDateTime(event.startAt)} – ${formatTime(event.endAt)}`}
            </span>
          )}
        </ModalHeader>
        <ModalBody className="gap-3 pb-2">
          {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}
          {!event && !error && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {event && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-default-500">
                <Chip
                  size="sm"
                  variant="flat"
                  style={event.feedColor ? { backgroundColor: `${event.feedColor}22` } : undefined}
                >
                  {event.feedName}
                </Chip>
                {event.location && <span>{event.location}</span>}
              </div>
              {event.description && (
                <p className="whitespace-pre-wrap text-sm text-default-600">{event.description}</p>
              )}

              <div className="flex items-center justify-between pt-1">
                <h4 className="text-xs font-semibold uppercase text-default-500">
                  Linked recordings
                </h4>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<LinkIcon className="h-3.5 w-3.5" />}
                  onPress={loadCandidates}
                  isDisabled={busy}
                >
                  Link a recording
                </Button>
              </div>

              {event.recordings.length === 0 && !showPicker && (
                <p className="text-sm text-default-500">No recordings linked to this event.</p>
              )}
              {event.recordings.map((recording) => (
                <div key={recording.id} className="flex items-center gap-3 rounded-medium bg-default-50 p-2">
                  <AudioIcon className="h-4 w-4 shrink-0 text-success" />
                  <Link
                    to={`/items/${recording.id}`}
                    className="min-w-0 flex-1 text-sm text-primary"
                  >
                    <span className="block truncate">{recordingLabel(recording)}</span>
                    <span className="block text-xs text-default-500">
                      {formatDateTime(itemDate(recording))}
                    </span>
                  </Link>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label="Unlink recording"
                    onPress={() => void unlink(recording.id)}
                    isDisabled={busy}
                  >
                    <UnlinkIcon className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              {showPicker && (
                <div className="flex flex-col gap-2 rounded-medium border border-default-200 p-2">
                  <span className="text-xs text-default-500">
                    Recordings around this event:
                  </span>
                  {candidates === null && (
                    <div className="flex justify-center py-2">
                      <Spinner size="sm" />
                    </div>
                  )}
                  {candidates?.length === 0 && (
                    <p className="text-sm text-default-500">No unlinked recordings nearby.</p>
                  )}
                  {candidates?.map((candidate) => (
                    <Button
                      key={candidate.id}
                      size="sm"
                      variant="flat"
                      className="justify-start"
                      onPress={() => void link(candidate.id)}
                      isDisabled={busy}
                    >
                      {recordingLabel(candidate)} · {formatDateTime(itemDate(candidate))}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
