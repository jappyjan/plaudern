import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { InboxItemDto } from '@plaudern/contracts';
import { getItem, listInbox } from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { InboxItemCard } from '../components/InboxItemCard';
import { RecordModal } from '../components/RecordModal';
import { UploadButton } from '../components/UploadButton';
import { MicIcon } from '../components/icons';

const PAGE_SIZE = 20;

export function InboxPage() {
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const page = await listInbox(PAGE_SIZE);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates: refetch the affected item and upsert it in place, so
  // transcription progress and items from other devices appear without a
  // reload — and without discarding already-loaded pagination pages.
  useInboxEvents({
    onEvent: (event) => {
      if (event.type === 'heartbeat') return;
      void getItem(event.itemId)
        .then((fetched) => {
          setItems((existing) => {
            if (!existing) return existing;
            const index = existing.findIndex((i) => i.id === fetched.id);
            if (index >= 0) {
              const next = existing.slice();
              next[index] = fetched;
              return next;
            }
            return [fetched, ...existing];
          });
        })
        .catch(() => undefined);
    },
    onReconnect: () => void refresh(),
  });

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listInbox(PAGE_SIZE, nextCursor);
      setItems((existing) => [...(existing ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-3">
        <Button
          color="danger"
          size="lg"
          className="flex-1"
          startContent={<MicIcon className="h-5 w-5" />}
          onPress={() => setRecordOpen(true)}
        >
          Record
        </Button>
        <UploadButton onSaved={() => void refresh()} />
      </div>

      {loadError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to load the inbox: {loadError}
        </div>
      )}

      {items === null && !loadError && (
        <div className="flex justify-center py-12">
          <Spinner label="Loading inbox…" />
        </div>
      )}

      {items?.length === 0 && (
        <p className="py-12 text-center text-sm text-default-500">
          Nothing here yet. Record a note or upload a recording to get started.
        </p>
      )}

      {items && items.length > 0 && (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <InboxItemCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {nextCursor && (
        <Button variant="flat" isLoading={loadingMore} onPress={loadMore}>
          Load more
        </Button>
      )}

      <RecordModal
        isOpen={recordOpen}
        onClose={() => setRecordOpen(false)}
        onSaved={() => void refresh()}
      />
    </div>
  );
}
