import { Card, CardBody, Chip } from '@heroui/react';
import type { InboxItemDto, SourceType } from '@plaudern/contracts';
import { useNavigate } from 'react-router-dom';
import { formatDateTime, formatDuration } from '../lib/format';
import { AudioIcon, FileIcon, LocationIcon, MicIcon, TextIcon } from './icons';
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

export function InboxItemCard({ item }: { item: InboxItemDto }) {
  const navigate = useNavigate();
  const tags = item.metadata?.tags as Record<string, unknown> | undefined;
  const duration = typeof tags?.durationSeconds === 'number' ? tags.durationSeconds : null;
  const hasLocation = Boolean(item.metadata?.location);
  const recordedViaMic = item.metadata?.capturedVia === 'browser-recording';

  return (
    <Card isPressable onPress={() => navigate(`/items/${item.id}`)} className="w-full">
      <CardBody className="flex flex-row items-center gap-3 py-3">
        <SourceIcon sourceType={item.sourceType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{itemTitle(item)}</p>
          <p className="text-xs text-default-500">{formatDateTime(item.occurredAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {duration !== null && (
            <span className="text-xs tabular-nums text-default-500">{formatDuration(duration)}</span>
          )}
          {recordedViaMic && <MicIcon className="h-4 w-4 text-default-400" />}
          {hasLocation && (
            <Chip size="sm" variant="flat" startContent={<LocationIcon className="h-3.5 w-3.5" />}>
              GPS
            </Chip>
          )}
          <TranscriptionChip item={item} />
        </div>
      </CardBody>
    </Card>
  );
}
