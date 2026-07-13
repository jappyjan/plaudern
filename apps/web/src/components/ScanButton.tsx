import { useRef, useState } from 'react';
import { Button, Progress } from '@heroui/react';
import { useIngest } from '../hooks/useIngest';
import { extractFileMetadata } from '../lib/fileMetadata';
import { ScanIcon } from './icons';

interface ScanFabProps {
  onSaved: (inboxItemId: string) => void;
}

/**
 * Photo/scan/document capture (`sources/image`, JJ-30/JJ-16), rendered as a
 * floating action button. Snap paper mail, a whiteboard, a receipt, a business
 * card, a handwritten note — or upload a PDF — and it flows into the OCR +
 * docmeta pipeline (vault, deadline reminders, business-card contacts).
 *
 * No `capture` attribute: on iOS it would force the camera open and make the
 * photo library unreachable. Without it, mobile browsers offer both the camera
 * and the gallery; desktop falls back to a file picker. Accepts images and PDFs.
 */
export function ScanFab({ onSaved }: ScanFabProps) {
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
        sourceType: 'image',
        occurredAt: extracted.occurredAt ?? new Date(file.lastModified).toISOString(),
        idempotencyKey: `${file.name}:${file.size}:${file.lastModified}`,
        originalFilename: file.name,
        metadata: {
          capturedVia: 'document-scan',
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
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      {busy && phase === 'uploading' && (
        <div className="w-48 rounded-medium bg-content1 px-3 py-2 shadow-medium">
          <p className="truncate text-xs text-default-500">{currentFile}</p>
          <Progress aria-label="Scan upload progress" value={progress * 100} size="sm" />
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
        aria-label="Scan document"
        className="h-14 w-14 bg-content2 shadow-large"
        isLoading={busy}
        onPress={() => {
          reset();
          inputRef.current?.click();
        }}
      >
        {!busy && <ScanIcon className="h-6 w-6" />}
      </Button>
    </div>
  );
}
