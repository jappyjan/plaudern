import { randomUUID } from 'node:crypto';

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/opus': 'opus',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'text/plain': 'txt',
};

export function extensionFor(contentType: string, originalFilename?: string | null): string {
  const known = EXT_BY_CONTENT_TYPE[contentType.toLowerCase()];
  if (known) return known;
  const fromName = originalFilename?.split('.').pop();
  return fromName && fromName.length <= 5 ? fromName.toLowerCase() : 'bin';
}

/**
 * Content-addressed, write-once key. Objects are never overwritten, preserving
 * source immutability (plan §2). `objectId` is random so distinct uploads never
 * collide even before the inbox item id exists.
 */
export function buildSourceStorageKey(
  userId: string,
  contentType: string,
  originalFilename?: string | null,
): string {
  const objectId = randomUUID();
  const ext = extensionFor(contentType, originalFilename);
  return `inbox/${userId}/${objectId}/source.${ext}`;
}
