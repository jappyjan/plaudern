import { Chip } from '@heroui/react';
import type { InboxItemDto } from '@plaudern/contracts';

/** The newest merge extraction; extractions arrive newest-first. */
function latestMerge(item: InboxItemDto) {
  return item.extractions.find((extraction) => extraction.kind === 'merge') ?? null;
}

/**
 * Progress indicator for the background audio merge, mirroring TranscriptionChip.
 * While the concatenation is queued/processing it shows "merging"; on failure it
 * shows "merge failed". Once it succeeds the chip disappears — the item's regular
 * "merged" badge already marks its provenance.
 */
export function MergeChip({ item }: { item: InboxItemDto }) {
  const merge = latestMerge(item);
  if (!merge || merge.status === 'succeeded') return null;
  if (merge.status === 'failed') {
    return (
      <Chip size="sm" variant="flat" color="danger">
        merge failed
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="flat" color="secondary">
      merging
    </Chip>
  );
}
