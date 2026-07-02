import { useEffect, useState } from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import type { CalendarEventDto } from '@plaudern/contracts';
import { createCalendarLink, listCalendarEvents } from '../../lib/api';
import { formatDate, formatDateTime, formatTimeRange } from '../../lib/format';

const DAY_MS = 24 * 60 * 60 * 1000;

interface LinkEventModalProps {
  isOpen: boolean;
  inboxItemId: string;
  occurredAt: string;
  alreadyLinkedIds: string[];
  onClose: () => void;
  onLinked: () => void;
}

/** Picker for manually attaching a recording to a calendar event nearby in time. */
export function LinkEventModal({
  isOpen,
  inboxItemId,
  occurredAt,
  alreadyLinkedIds,
  onClose,
  onLinked,
}: LinkEventModalProps) {
  const [events, setEvents] = useState<CalendarEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setEvents(null);
    setError(null);
    const from = new Date(Date.parse(occurredAt) - DAY_MS).toISOString();
    const to = new Date(Date.parse(occurredAt) + DAY_MS).toISOString();
    listCalendarEvents(from, to)
      .then(({ events: fetched }) =>
        setEvents(fetched.filter((event) => !alreadyLinkedIds.includes(event.id))),
      )
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [isOpen, occurredAt, alreadyLinkedIds]);

  const link = async (eventId: string) => {
    setBusy(true);
    try {
      await createCalendarLink(inboxItemId, eventId);
      onLinked();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>Link to a calendar event</ModalHeader>
        <ModalBody className="gap-2 pb-2">
          <p className="text-xs text-default-500">
            Events within a day of the recording ({formatDateTime(occurredAt)}):
          </p>
          {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}
          {events === null && !error && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}
          {events?.length === 0 && (
            <p className="text-sm text-default-500">
              No unlinked events nearby. Add a calendar feed in settings first.
            </p>
          )}
          {events?.map((event) => (
            <Button
              key={event.id}
              variant="flat"
              className="h-auto justify-start py-2"
              onPress={() => void link(event.id)}
              isDisabled={busy}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span className="max-w-full truncate text-sm">{event.title ?? '(untitled event)'}</span>
                <span className="text-xs text-default-500">
                  {event.isAllDay
                    ? `All day · ${formatDate(event.startAt)}`
                    : `${formatDate(event.startAt)} · ${formatTimeRange(event.startAt, event.endAt)}`}
                  {' · '}
                  {event.feedName}
                </span>
              </span>
            </Button>
          ))}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            Cancel
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
