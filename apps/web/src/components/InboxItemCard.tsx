import { useState } from 'react';
import { Button, Card, CardBody, Chip } from '@heroui/react';
import type { InboxItemDto, SourceType } from '@plaudern/contracts';
import { useNavigate } from 'react-router-dom';
import { deleteInboxItem } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { usePlaceName } from '../hooks/usePlaceName';
import { AudioIcon, FileIcon, LocationIcon, MicIcon, TextIcon, TrashIcon } from './icons';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { TranscriptionChip } from './TranscriptionChip';

function SourceIcon({ sourceType }: { sourceType: SourceType }) {
  const className = 'h-5 w-5 shrink-0 text-default-500';
  switch (sourceType) {
    case 'audio':
    case 'plaud':
      return <AudioIcon className={className} />;
    case 'text':
      return <TextIcon className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

function itemTitle(item: InboxItemDto): string {
  const tags = item.metadata?.tags as Record<string, unknown> | undefined;
  if (typeof tags?.title === 'string' && tags.title) return tags.title;
  if (item.source?.originalFilename) return item.source.originalFilename;
  if (item.metadata?.capturedVia === 'browser-recording') return 'Browser recording';
  return `${item.sourceType} note`;
}

export function InboxItemCard({
  item,
  onDeleted,
}: {
  item: InboxItemDto;
  onDeleted: (id: string) => void;
}) {
  const navigate = useNavigate();
  const tags = item.metadata?.tags as Record<string, unknown> | undefined;
  const duration = typeof tags?.durationSeconds === 'number' ? tags.durationSeconds : null;
  const location = item.metadata?.location as { lat: number; lon: number } | undefined;
  const { city } = usePlaceName(location);
  const recordedViaMic = item.metadata?.capturedVia === 'browser-recording';

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteInboxItem(item.id);
      setConfirmOpen(false);
      onDeleted(item.id);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    // The card is a <button> (isPressable), so the delete trigger is an
    // absolutely-positioned sibling — nesting buttons is invalid HTML.
    <div className="relative w-full">
      <Card isPressable onPress={() => navigate(`/items/${item.id}`)} className="w-full">
        <CardBody className="gap-1 py-2.5 pr-12">
          {/* Main line: the title gets the full row width. */}
          <div className="flex items-center gap-2">
            <SourceIcon sourceType={item.sourceType} />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{itemTitle(item)}</p>
          </div>
          {/* Meta line: date, duration and tags, aligned under the title. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-xs text-default-500">
            <span className="whitespace-nowrap">{formatDateTime(item.occurredAt)}</span>
            {duration !== null && (
              <span className="tabular-nums">{formatDuration(duration)}</span>
            )}
            {recordedViaMic && <MicIcon className="h-3.5 w-3.5 shrink-0 text-default-400" />}
            {location && (
              <Chip
                size="sm"
                variant="flat"
                startContent={<LocationIcon className="h-3.5 w-3.5" />}
              >
                <span className="max-w-32 truncate">{city ?? 'GPS'}</span>
              </Chip>
            )}
            <TranscriptionChip item={item} />
          </div>
        </CardBody>
      </Card>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        aria-label="Delete"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-default-400 hover:text-danger"
        onPress={() => setConfirmOpen(true)}
      >
        <TrashIcon className="h-4 w-4" />
      </Button>
      <ConfirmDeleteModal
        isOpen={confirmOpen}
        isDeleting={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setConfirmOpen(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
