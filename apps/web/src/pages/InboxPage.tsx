import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '@heroui/react';
import type { InboxItemDto } from '@plaudern/contracts';
import { getItem, listInbox, mergeItems } from '../lib/api';
import { useInboxEvents } from '../hooks/useInboxEvents';
import { InboxItemCard } from '../components/InboxItemCard';
import { NoteModal } from '../components/NoteModal';
import { RecordModal } from '../components/RecordModal';
import { UploadFab } from '../components/UploadButton';
import { MicIcon, SearchIcon, TextIcon } from '../components/icons';

const PAGE_SIZE = 20;

/** Only committed audio recordings can be concatenated. */
function isMergeable(item: InboxItemDto): boolean {
  return (
    item.source?.uploadStatus === 'committed' &&
    (item.source?.contentType.startsWith('audio/') ?? false)
  );
}

export function InboxPage() {
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
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
      await mergeItems([...selected]);
      exitSelectMode();
      // Stay on the inbox: the new merged item appears here with a "merging"
      // progress chip while the background audio merge runs, and the selected
      // sources are hidden. SSE keeps it live until the merge completes.
      await refresh();
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

  // Long-pressing a mergeable recording enters selection mode with it selected.
  const enterSelectMode = (id: string) => {
    setSelectMode(true);
    setSelected((existing) => {
      const next = new Set(existing);
      next.add(id);
      return next;
    });
  };

  const mergeableCount = items?.filter(isMergeable).length ?? 0;

  return (
    // Bottom padding keeps the last cards reachable above the floating actions.
    <div className="flex flex-col gap-6 pb-28">
      {!selectMode && (
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <Button
            as={Link}
            to="/search"
            isIconOnly
            variant="flat"
            size="sm"
            aria-label="Search your memory"
          >
            <SearchIcon className="h-5 w-5" />
          </Button>
        </div>
      )}
      {!selectMode && (
        <Button
          color="danger"
          size="lg"
          startContent={<MicIcon className="h-5 w-5" />}
          onPress={() => setRecordOpen(true)}
        >
          Record
        </Button>
      )}

      {mergeError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to merge: {mergeError}
        </div>
      )}

      {selectMode ? (
        <p className="text-sm text-default-500">
          Pick at least two recordings to combine them into one. The originals are kept and can be
          restored by splitting the merged recording.
        </p>
      ) : (
        mergeableCount >= 2 && (
          <p className="text-xs text-default-400">
            Tip: press and hold a recording to select several and merge them.
          </p>
        )
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
              onLongPress={mergeableCount >= 2 && isMergeable(item) ? enterSelectMode : undefined}
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

      {/* Thumb-reachable floating actions, kept above the bottom tab bar. */}
      {!selectMode && (
        <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex flex-col items-end gap-3 md:bottom-8">
          <UploadFab onSaved={() => void refresh()} />
          <Button
            isIconOnly
            radius="full"
            size="lg"
            aria-label="New note"
            className="h-14 w-14 bg-content2 shadow-large"
            onPress={() => setNoteOpen(true)}
          >
            <TextIcon className="h-6 w-6" />
          </Button>
        </div>
      )}

      {/* Selection mode replaces the FABs with a floating merge bar. */}
      {selectMode && (
        <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 px-4 md:bottom-8">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-large bg-content1 p-3 shadow-large">
            <Button variant="flat" onPress={exitSelectMode}>
              Cancel
            </Button>
            <Button
              color="primary"
              className="flex-1"
              isDisabled={selected.size < 2}
              isLoading={merging}
              onPress={() => void mergeSelected()}
            >
              Merge {selected.size >= 2 ? `${selected.size} recordings` : 'recordings'}
            </Button>
          </div>
        </div>
      )}

      <RecordModal
        isOpen={recordOpen}
        onClose={() => setRecordOpen(false)}
        onSaved={() => void refresh()}
      />
      <NoteModal
        isOpen={noteOpen}
        onClose={() => setNoteOpen(false)}
        onSaved={() => void refresh()}
      />
    </div>
  );
}
