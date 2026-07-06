import type {
  ExtractedPayloadDto,
  InboxItemDto,
  SourcePayloadDto,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SourcePayloadEntity,
} from '@plaudern/persistence';

const iso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
};

export function toSourcePayloadDto(entity: SourcePayloadEntity): SourcePayloadDto {
  return {
    id: entity.id,
    storageKey: entity.storageKey,
    contentType: entity.contentType,
    byteSize: entity.byteSize,
    checksum: entity.checksum,
    originalFilename: entity.originalFilename,
    uploadStatus: entity.uploadStatus,
    createdAt: iso(entity.createdAt)!,
  };
}

export function toExtractedPayloadDto(entity: ExtractedPayloadEntity): ExtractedPayloadDto {
  return {
    id: entity.id,
    kind: entity.kind,
    version: entity.version ?? 1,
    provider: entity.provider,
    status: entity.status,
    content: entity.content,
    segments: entity.segments ?? null,
    language: entity.language,
    error: entity.error,
    createdAt: iso(entity.createdAt)!,
    completedAt: iso(entity.completedAt),
  };
}

export function toInboxItemDto(entity: InboxItemEntity): InboxItemDto {
  return {
    id: entity.id,
    sourceType: entity.sourceType,
    occurredAt: iso(entity.occurredAt)!,
    ingestedAt: iso(entity.ingestedAt)!,
    // Extracted document date (scanned docs only); null when the relation isn't
    // loaded or no date was found, so clients fall back to occurredAt.
    documentDate: entity.documentMetadata?.documentDate ?? null,
    metadata: entity.metadata ?? null,
    source: entity.source ? toSourcePayloadDto(entity.source) : null,
    extractions: (entity.extractions ?? [])
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(toExtractedPayloadDto),
    // Optional: many call sites load items without the mergeSources relation.
    ...(entity.mergeSources?.length
      ? {
          mergedFromItemIds: entity.mergeSources
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((link) => link.sourceItemId),
        }
      : {}),
  };
}
