import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { InboxItemDto } from '@plaudern/contracts';
import { useNavigate } from 'react-router-dom';
import { getItem, listInbox, mergeItems } from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { InboxItemCard } from '../components/InboxItemCard';
import { RecordModal } from '../components/RecordModal';
import { UploadButton } from '../components/UploadButton';
import { MicIcon } from '../components/icons';

const PAGE_SIZE = 20;

/** Only committed audio recordings can be concatenated. */
function isMergeable(item: InboxItemDto): boolean {
  return (
    item.source?.uploadStatus === 'committed' &&
    (item.source?.contentType.startsWith('audio/') ?? false)
  );
}

export function InboxPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  // Multi-select for merging recordings.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

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
      // Deletes must be handled before the refetch-and-upsert below: fetching
      // a deleted item 404s, and a racing event could re-insert a stale entry.
      if (event.type === 'item.deleted') {
        setItems((existing) => existing?.filter((i) => i.id !== event.itemId) ?? existing);
        return;
      }
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

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setMergeError(null);
  };

  const toggleSelect = (id: string) =>
    setSelected((existing) => {
      const next = new Set(existing);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mergeSelected = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      const merged = await mergeItems([...selected]);
      exitSelectMode();
      await refresh();
      navigate(`/items/${merged.id}`);
    } catch (cause) {
      setMergeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMerging(false);
    }
  };

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

  const mergeableCount = items?.filter(isMergeable).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-3">
        {!selectMode && (
          <>
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
          </>
        )}
        {mergeableCount >= 2 && (
          <Button
            variant="flat"
            size="lg"
            className={selectMode ? 'flex-1' : ''}
            onPress={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            {selectMode ? 'Cancel' : 'Select'}
          </Button>
        )}
        {selectMode && (
          <Button
            color="primary"
            size="lg"
            className="flex-1"
            isDisabled={selected.size < 2}
            isLoading={merging}
            onPress={() => void mergeSelected()}
          >
            Merge {selected.size >= 2 ? `${selected.size} recordings` : 'recordings'}
          </Button>
        )}
      </div>

      {mergeError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to merge: {mergeError}
        </div>
      )}

      {selectMode && (
        <p className="text-sm text-default-500">
          Pick at least two recordings to combine them into one. The originals are kept and can be
          restored by splitting the merged recording.
        </p>
      )}

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
            <InboxItemCard
              key={item.id}
              item={item}
              selectable={selectMode}
              selected={selected.has(item.id)}
              selectionDisabled={!isMergeable(item)}
              onToggleSelect={toggleSelect}
              onDeleted={(id) =>
                setItems((existing) => existing?.filter((i) => i.id !== id) ?? existing)
              }
            />
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
