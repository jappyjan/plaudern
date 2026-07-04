import { randomUUID } from 'node:crypto';

/**
 * Content-addressed, write-once key for an email attachment blob — same
 * immutability guarantee as `buildSourceStorageKey` in `@plaudern/ingestion`,
 * just filed under `attachments/` since an inbox item's primary `source` slot
 * is already used by the subject/body text.
 */
export function buildEmailAttachmentStorageKey(userId: string, filename: string | null): string {
  const objectId = randomUUID();
  const safeName = sanitizeFilename(filename) ?? 'attachment';
  return `inbox/${userId}/${objectId}/attachments/${safeName}`;
}

function sanitizeFilename(filename: string | null): string | null {
  if (!filename) return null;
  const base = filename.split(/[\\/]/).pop()?.trim();
  if (!base) return null;
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}
