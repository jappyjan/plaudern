import { Card, CardBody, Chip } from '@heroui/react';
import type { InboxItemDto, SourceType } from '@plaudern/contracts';
import { useNavigate } from 'react-router-dom';
import { formatDateTime, formatDuration } from '../lib/format';
import { usePlaceName } from '../hooks/usePlaceName';
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
  const location = item.metadata?.location as { lat: number; lon: number } | undefined;
  const { city } = usePlaceName(location);
  const recordedViaMic = item.metadata?.capturedVia === 'browser-recording';

  return (
    <Card isPressable onPress={() => navigate(`/items/${item.id}`)} className="w-full">
      <CardBody className="gap-1 py-2.5">
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
  );
}
