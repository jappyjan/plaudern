import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import type { ItemDocMetaResponse, ItemOcrResponse } from '@plaudern/contracts';
import {
  getItemDocMeta,
  getItemOcr,
  retryItemDocMeta,
  retryItemOcr,
} from '../lib/api';

interface DocumentSectionProps {
  itemId: string;
  contentType: string | null | undefined;
  sourceUrl: string | null;
}

/**
 * The scanned-document panel on an item's detail page (JJ-30/JJ-16): a preview
 * of the image, the structured document understanding (type, key fields, expiry
 * / Kündigungsfrist), and the recognized OCR text behind a plain toggle
 * (iOS-PWA-safe — no HeroUI overlay). Only rendered for image/PDF items.
 */
export function DocumentSection({ itemId, contentType, sourceUrl }: DocumentSectionProps) {
  const [docmeta, setDocmeta] = useState<ItemDocMetaResponse | null>(null);
  const [ocr, setOcr] = useState<ItemOcrResponse | null>(null);
  const [showText, setShowText] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, o] = await Promise.all([
      getItemDocMeta(itemId).catch(() => null),
      getItemOcr(itemId).catch(() => null),
    ]);
    setDocmeta(d);
    setOcr(o);
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async () => {
    setBusy(true);
    try {
      // Re-run OCR first (docmeta depends on it); the pipeline chains docmeta.
      await retryItemOcr(itemId).catch(() => null);
      await retryItemDocMeta(itemId).catch(() => null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const isImage = (contentType ?? '').startsWith('image/');
  const doc = docmeta?.document ?? null;
  const pending =
    docmeta?.status === 'queued' ||
    docmeta?.status === 'processing' ||
    ocr?.status === 'queued' ||
    ocr?.status === 'processing';

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-default-600">Scanned document</h3>
          <Button size="sm" variant="light" isLoading={busy} onPress={() => void retry()}>
            Re-scan
          </Button>
        </div>

        {isImage && sourceUrl && (
          <img
            src={sourceUrl}
            alt="Scanned document"
            className="max-h-96 w-full rounded-medium object-contain"
          />
        )}
        {!isImage && sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline"
          >
            Open document
          </a>
        )}

        {pending && (
          <div className="flex items-center gap-2 text-sm text-default-500">
            <Spinner size="sm" /> Reading the document…
          </div>
        )}

        {doc && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Chip size="sm" variant="flat" color="primary">
                {doc.documentType.replace(/_/g, ' ')}
              </Chip>
              {doc.expiryDate && (
                <Chip size="sm" variant="flat" color="warning">
                  Expires {doc.expiryDate}
                </Chip>
              )}
              {doc.cancellationDate && (
                <Chip size="sm" variant="flat" color="danger">
                  Kündigungsfrist {doc.cancellationDate}
                </Chip>
              )}
            </div>
            <p className="font-medium">{doc.title}</p>
            {doc.issuer && <p className="text-sm text-default-500">{doc.issuer}</p>}
            {doc.summary && <p className="text-sm text-default-600">{doc.summary}</p>}
            {doc.fields.length > 0 && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {doc.fields.map((f, i) => (
                  <div key={i} className="contents">
                    <dt className="text-default-500">{f.label}</dt>
                    <dd className="min-w-0 break-words">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        {docmeta?.status === 'failed' && docmeta.error && (
          <p className="rounded-medium bg-danger-50 p-2 text-xs text-danger">{docmeta.error}</p>
        )}

        {ocr?.text && (
          <div className="border-t border-default-100 pt-2">
            <button
              type="button"
              onClick={() => setShowText((v) => !v)}
              className="text-sm text-default-500 hover:text-foreground"
            >
              {showText ? '▾' : '▸'} Recognized text
            </button>
            {showText && (
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-medium bg-default-50 p-3 text-xs text-default-700">
                {ocr.text}
              </pre>
            )}
          </div>
        )}

        {!pending && !doc && ocr?.status !== 'failed' && !ocr?.text && (
          <p className="text-sm text-default-500">
            OCR + document understanding have not run yet. They require a vision-capable model
            to be configured; use Re-scan once it is.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
