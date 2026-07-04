import { useMemo, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Input, Textarea } from '@heroui/react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ingestText, ingestWeb } from '../lib/api';
import { LinkIcon } from '../components/icons';

/** First http(s) URL inside a blob of shared text, if any. */
function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"')\]]+/i.exec(text);
  return match ? match[0] : null;
}

/**
 * PWA share-target capture page (manifest `share_target` → GET /share).
 * Android (and other share sheets) put the page URL sometimes in `url`,
 * sometimes inside `text` — normalize both. With a URL the clip goes to the
 * web-clipper adapter (server fetches a readable snapshot as link-rot
 * insurance); without one the share is saved as a plain text note.
 */
export function SharePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const shared = useMemo(() => {
    const rawUrl = params.get('url')?.trim() || null;
    const rawText = params.get('text')?.trim() || '';
    const rawTitle = params.get('title')?.trim() || '';
    const url = rawUrl ?? firstUrl(rawText);
    // When the "text" is just the URL (the common Android share shape),
    // there is no snapshot worth keeping — let the server extract one.
    const leftoverText = url ? rawText.replace(url, '').trim() : rawText;
    return { url, title: rawTitle, text: leftoverText };
  }, [params]);

  const [url, setUrl] = useState(shared.url ?? '');
  const [title, setTitle] = useState(shared.title);
  const [text, setText] = useState(shared.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedItemId, setSavedItemId] = useState<string | null>(null);
  // One key per share navigation: retrying a failed save stays idempotent.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const canSave = url.trim() !== '' || text.trim() !== '';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const occurredAt = new Date().toISOString();
      const trimmedUrl = url.trim();
      const item = trimmedUrl
        ? await ingestWeb({
            url: trimmedUrl,
            title: title.trim() || undefined,
            text: text.trim() || undefined,
            occurredAt,
            idempotencyKey,
            metadata: { capturedVia: 'share-target' },
          })
        : await ingestText({
            text: [title.trim(), text.trim()].filter(Boolean).join('\n\n'),
            occurredAt,
            idempotencyKey,
            metadata: { capturedVia: 'share-target', tags: title.trim() ? { title: title.trim() } : {} },
          });
      setSavedItemId(item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (savedItemId) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success-100 text-2xl">
          ✓
        </div>
        <p className="text-sm text-default-600">Saved to your inbox.</p>
        <div className="flex gap-2">
          <Button as={Link} to={`/items/${savedItemId}`} color="primary" size="sm">
            Open item
          </Button>
          <Button as={Link} to="/" variant="flat" size="sm">
            Go to inbox
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex items-center gap-2 pb-0">
          <LinkIcon className="h-5 w-5 text-default-500" />
          <h1 className="text-base font-semibold">Save to Plaudern</h1>
        </CardHeader>
        <CardBody className="gap-3">
          <Input
            label="Link"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onValueChange={setUrl}
          />
          <Input label="Title" placeholder="Optional title" value={title} onValueChange={setTitle} />
          <Textarea
            label="Text"
            placeholder="Optional note or captured text — leave empty to snapshot the page"
            minRows={3}
            value={text}
            onValueChange={setText}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="flat" onPress={() => navigate('/')} isDisabled={saving}>
              Cancel
            </Button>
            <Button color="primary" onPress={() => void save()} isLoading={saving} isDisabled={!canSave}>
              Save
            </Button>
          </div>
          {url.trim() !== '' && text.trim() === '' && (
            <p className="text-xs text-default-400">
              The page will be fetched and a readable-text snapshot stored alongside the link.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
