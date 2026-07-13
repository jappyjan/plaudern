import { useRef, useState } from 'react';
import { Button, Progress } from '@heroui/react';
import { hasDocumentPayload, type SourceType } from '@plaudern/contracts';
import { useIngest } from '../hooks/useIngest';
import { extractFileMetadata } from '../lib/fileMetadata';
import { UploadIcon } from './icons';

function sourceTypeFor(contentType: string): SourceType {
  if (contentType.startsWith('audio/')) return 'audio';
  if (hasDocumentPayload(contentType)) return 'image';
  return 'file';
}

interface UploadFabProps {
  onSaved: (inboxItemId: string) => void;
}

/**
 * File-upload path, rendered as a floating action button. Capture metadata
 * (recording time, GPS, device, tags) is extracted from the file's own
 * embedded tags; the browser's location is deliberately NOT attached — where
 * you upload from is not where you recorded.
 */
export function UploadFab({ onSaved }: UploadFabProps) {
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
        sourceType: sourceTypeFor(file.type),
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
    <div className="flex flex-col items-end gap-2">
      {/*
        Accepts audio, images and PDFs — not just audio. On iOS, `accept="audio/*"`
        alone maps to the video picker (there is no system audio picker in the
        Photos flow), which made the button offer videos only and blocked
        selecting images from the gallery.
      */}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      {/* Progress and errors float next to the FAB stack. */}
      {busy && phase === 'uploading' && (
        <div className="w-48 rounded-medium bg-content1 px-3 py-2 shadow-medium">
          <p className="truncate text-xs text-default-500">{currentFile}</p>
          <Progress aria-label="Upload progress" value={progress * 100} size="sm" />
        </div>
      )}
      {error && (
        <p className="max-w-60 rounded-medium bg-danger-50 px-3 py-2 text-xs text-danger shadow-medium">
          {error}
        </p>
      )}
      <Button
        isIconOnly
        radius="full"
        size="lg"
        aria-label="Upload"
        className="h-14 w-14 bg-content2 shadow-large"
        isLoading={busy}
        onPress={() => {
          reset();
          inputRef.current?.click();
        }}
      >
        {!busy && <UploadIcon className="h-6 w-6" />}
      </Button>
    </div>
  );
}
