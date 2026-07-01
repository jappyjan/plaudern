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
    provider: entity.provider,
    status: entity.status,
    content: entity.content,
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
    source: entity.source ? toSourcePayloadDto(entity.source) : null,
    extractions: (entity.extractions ?? [])
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(toExtractedPayloadDto),
  };
}
