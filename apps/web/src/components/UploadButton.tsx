import { useRef, useState } from 'react';
import { Button, Progress } from '@heroui/react';
import { useIngest } from '../hooks/useIngest';
import { extractFileMetadata } from '../lib/fileMetadata';
import { UploadIcon } from './icons';

interface UploadButtonProps {
  onSaved: (inboxItemId: string) => void;
}

/**
 * File-upload path. Capture metadata (recording time, GPS, device, tags) is
 * extracted from the file's own embedded tags; the browser's location is
 * deliberately NOT attached — where you upload from is not where you recorded.
 */
export function UploadButton({ onSaved }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { phase, progress, error, ingest, reset } = useIngest();
  const [currentFile, setCurrentFile] = useState<string | null>(null);

  const busy = phase === 'init' || phase === 'uploading' || phase === 'committing';

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setCurrentFile(file.name);
      const extracted = await extractFileMetadata(file);
      const itemId = await ingest({
        blob: file,
        contentType: file.type || 'application/octet-stream',
        sourceType: file.type.startsWith('audio/') ? 'audio' : 'file',
        occurredAt: extracted.occurredAt ?? new Date(file.lastModified).toISOString(),
        idempotencyKey: `${file.name}:${file.size}:${file.lastModified}`,
        originalFilename: file.name,
        metadata: {
          capturedVia: 'file-upload',
          ...(extracted.location ? { location: extracted.location } : {}),
          ...(extracted.device ? { device: extracted.device } : {}),
          ...(extracted.tags ? { tags: extracted.tags } : {}),
        },
      });
      if (itemId) onSaved(itemId);
      else break; // stop the batch on the first failure; the error stays visible
    }
    setCurrentFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="flex flex-1 flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <Button
        variant="flat"
        size="lg"
        startContent={!busy && <UploadIcon className="h-5 w-5" />}
        isLoading={busy}
        onPress={() => {
          reset();
          inputRef.current?.click();
        }}
        className="w-full"
      >
        {busy ? `Uploading ${currentFile ?? ''}` : 'Upload'}
      </Button>
      {busy && phase === 'uploading' && (
        <Progress aria-label="Upload progress" value={progress * 100} size="sm" />
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
