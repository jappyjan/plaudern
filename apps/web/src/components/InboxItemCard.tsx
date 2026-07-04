import { useState } from 'react';
import { Button, Card, CardBody, Chip } from '@heroui/react';
import { summaryPayloadSchema, type InboxItemDto, type SourceType } from '@plaudern/contracts';
import { useNavigate } from 'react-router-dom';
import { deleteInboxItem } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { usePlaceName } from '../hooks/usePlaceName';
import { AudioIcon, FileIcon, LinkIcon, LocationIcon, MicIcon, TextIcon, TrashIcon } from './icons';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { TranscriptionChip } from './TranscriptionChip';
import { MergeChip } from './MergeChip';

function SourceIcon({ sourceType }: { sourceType: SourceType }) {
  const className = 'h-5 w-5 shrink-0 text-default-500';
  switch (sourceType) {
    case 'audio':
    case 'plaud':
      return <AudioIcon className={className} />;
    case 'text':
      return <TextIcon className={className} />;
    case 'web':
      return <LinkIcon className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

/** The AI summary's title, when one has been generated for this item. */
function summaryTitle(item: InboxItemDto): string | null {
  const summary = item.extractions.find(
    (e) => e.kind === 'summary' && e.status === 'succeeded',
  );
  if (!summary?.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(summary.content));
    return parsed.success && parsed.data.title ? parsed.data.title : null;
  } catch {
    return null;
  }
}

function itemTitle(item: InboxItemDto): string {
  // Prefer the AI-generated descriptive title once it's available.
  const aiTitle = summaryTitle(item);
  if (aiTitle) return aiTitle;
  const tags = item.metadata?.tags as Record<string, unknown> | undefined;
  if (typeof tags?.title === 'string' && tags.title) return tags.title;
  if (item.source?.originalFilename) return item.source.originalFilename;
  if (item.metadata?.capturedVia === 'browser-recording') return 'Browser recording';
  return `${item.sourceType} note`;
}

export function InboxItemCard({
  item,
  onDeleted,
  selectable = false,
  selected = false,
  selectionDisabled = false,
  onToggleSelect,
}: {
  item: InboxItemDto;
  onDeleted: (id: string) => void;
  /** Selection mode: pressing toggles selection instead of navigating. */
  selectable?: boolean;
  selected?: boolean;
  /** In selection mode, items that cannot be merged are dimmed and inert. */
  selectionDisabled?: boolean;
  onToggleSelect?: (id: string) => void;
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
    <div className={`relative w-full ${selectable && selectionDisabled ? 'opacity-40' : ''}`}>
      <Card
        isPressable={!selectable || !selectionDisabled}
        onPress={() =>
          selectable
            ? !selectionDisabled && onToggleSelect?.(item.id)
            : navigate(`/items/${item.id}`)
        }
        className={`w-full ${selected ? 'outline outline-2 outline-primary' : ''}`}
      >
        <CardBody className="gap-1 py-2.5 pr-12">
          {/* Main line: the title gets the full row width. */}
          <div className="flex items-center gap-2">
            {selectable && (
              <span
                aria-hidden
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-default-300 text-transparent'
                }`}
              >
                ✓
              </span>
            )}
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
            <MergeChip item={item} />
            <TranscriptionChip item={item} />
            {item.extractions.some((e) => e.kind === 'summary' && e.status === 'succeeded') && (
              <Chip size="sm" variant="flat" color="secondary">
                summary
              </Chip>
            )}
            {/* Provenance badge for a completed merge. Hidden while the merge is
                still in progress or failed — MergeChip covers those states. */}
            {(item.mergedFromItemIds?.length ?? 0) > 0 &&
              !item.extractions.some(
                (e) => e.kind === 'merge' && e.status !== 'succeeded',
              ) && (
                <Chip size="sm" variant="flat" color="warning">
                  merged
                </Chip>
              )}
          </div>
        </CardBody>
      </Card>
      {!selectable && (
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
      )}
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
