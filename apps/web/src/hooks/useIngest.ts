import { useCallback, useState } from 'react';
import type { SourceType } from '@plaudern/contracts';
import { ingestCommit, ingestInit, uploadToPresignedUrl } from '../lib/api';

export interface IngestInput {
  blob: Blob;
  contentType: string;
  sourceType: SourceType;
  occurredAt: string;
  idempotencyKey: string;
  originalFilename?: string;
  metadata?: Record<string, unknown>;
}

export type IngestPhase = 'idle' | 'init' | 'uploading' | 'committing' | 'done' | 'error';

/**
 * Drives the two-phase ingestion for one blob:
 *   init -> presigned PUT (with progress) -> commit.
 * When init reports the idempotency key already committed, upload and commit
 * are skipped and the existing item id is returned.
 */
export function useIngest() {
  const [phase, setPhase] = useState<IngestPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ingest = useCallback(async (input: IngestInput): Promise<string | null> => {
    setPhase('init');
    setProgress(0);
    setError(null);
    try {
      const init = await ingestInit({
        sourceType: input.sourceType,
        contentType: input.contentType,
        byteSize: input.blob.size,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        originalFilename: input.originalFilename,
        metadata: input.metadata,
      });

      if (!init.alreadyCommitted) {
        setPhase('uploading');
        await uploadToPresignedUrl(init.uploadUrl, input.blob, input.contentType, setProgress);
        setPhase('committing');
        await ingestCommit(init.inboxItemId);
      }

      setPhase('done');
      return init.inboxItemId;
    } catch (cause) {
      setPhase('error');
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setError(null);
  }, []);

  return { phase, progress, error, ingest, reset };
}
