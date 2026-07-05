import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Accordion,
  AccordionItem,
  Button,
  Card,
  CardBody,
  Chip,
  Spinner,
} from '@heroui/react';
import type {
  TopicDocumentCitation,
  TopicDocumentResponse,
  TopicDocumentVersionDto,
} from '@plaudern/contracts';
import {
  getTopicDocument,
  getTopicDocumentVersion,
  listTopicDocumentVersions,
  regenerateTopicDocument,
} from '../lib/api';
import { Markdown } from './Markdown';
import { formatDate, formatDateTime, formatDuration } from '../lib/format';
import { FileIcon, LoopIcon, PlayIcon } from './icons';

const POLL_INTERVAL_MS = 3000;

/**
 * Living topic document (JJ-12): the evergreen, self-updating Markdown document
 * the AI maintains for a topic. It regenerates itself whenever a new item is
 * classified into the topic; every statement cites its source items, rendered
 * as chips that deep-link to the item (and, when known, the audio moment) —
 * reusing the memory-chat citation pattern. A version history lets the topic's
 * evolution be inspected. Hangs off the topic detail page — no new nav tab.
 */
export function TopicDocumentCard({ topicId }: { topicId: string }) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<TopicDocumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [versions, setVersions] = useState<TopicDocumentVersionDto[] | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<TopicDocumentResponse | null> => {
    try {
      const fetched = await getTopicDocument(topicId);
      setDoc(fetched);
      setError(null);
      return fetched;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [topicId]);

  // Fetch on mount and keep polling while a generation is in flight.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const fetched = await load();
      if (cancelled) return;
      if (fetched && (fetched.status === 'queued' || fetched.status === 'processing')) {
        pollRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [load]);

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setError(null);
    try {
      const fresh = await regenerateTopicDocument(topicId);
      setDoc(fresh);
      setVersions(null);
      // Resume polling until the fresh generation settles.
      if (pollRef.current) clearTimeout(pollRef.current);
      const poll = async () => {
        const fetched = await load();
        if (fetched && (fetched.status === 'queued' || fetched.status === 'processing')) {
          pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      };
      pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRegenerating(false);
    }
  }, [topicId, load]);

  const openCitation = (citation: TopicDocumentCitation) => {
    const seek =
      citation.startSeconds !== null ? `?t=${Math.max(0, Math.floor(citation.startSeconds))}` : '';
    navigate(`/items/${citation.inboxItemId}${seek}`);
  };

  // Feature unconfigured on this server — hide it rather than offer a dead action.
  if (doc && !doc.enabled && !doc.markdown) {
    return null;
  }

  const busy = doc?.status === 'queued' || doc?.status === 'processing' || regenerating;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileIcon className="h-4 w-4" />
            Living document
            {doc?.version && (
              <Chip size="sm" variant="flat">
                v{doc.version}
              </Chip>
            )}
          </h2>
          {doc?.enabled && (
            <Button
              size="sm"
              variant="flat"
              startContent={<LoopIcon className="h-4 w-4" />}
              isDisabled={busy}
              isLoading={regenerating}
              onPress={() => void regenerate()}
            >
              Regenerate
            </Button>
          )}
        </div>

        {!doc && !error && (
          <div className="flex justify-center py-6">
            <Spinner size="sm" label="Loading…" />
          </div>
        )}

        {busy && (
          <div className="flex items-center gap-2 text-sm text-default-500">
            <Spinner size="sm" /> Writing the document…
          </div>
        )}

        {doc?.status === 'failed' && doc.error && !doc.markdown && (
          <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
            Generation failed: {doc.error}
          </div>
        )}

        {doc && doc.markdown === null && !busy && doc.status !== 'failed' && (
          <p className="text-sm text-default-500">
            No document yet. It is written automatically as items are classified into this topic,
            or you can generate it now.
          </p>
        )}

        {doc?.markdown && (
          <>
            <Markdown>{doc.markdown}</Markdown>

            {doc.citations.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-default-100 pt-2">
                <p className="text-xs font-medium text-default-500">Sources</p>
                <div className="flex flex-wrap gap-1">
                  {doc.citations.map((citation) => (
                    <Chip
                      key={citation.marker}
                      size="sm"
                      variant="flat"
                      color="primary"
                      className="max-w-64 cursor-pointer"
                      startContent={
                        citation.startSeconds !== null ? (
                          <PlayIcon className="h-3 w-3" />
                        ) : undefined
                      }
                      onClick={() => openCitation(citation)}
                    >
                      [{citation.marker}] {citation.title ?? 'Untitled'}
                      {citation.startSeconds !== null &&
                        ` · ${formatDuration(citation.startSeconds)}`}
                      {` · ${formatDate(citation.occurredAt)}`}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            {doc.generatedAt && (
              <p className="text-xs text-default-400">
                Updated {formatDateTime(doc.generatedAt)}
                {doc.model ? ` · ${doc.model}` : ''}
              </p>
            )}

            <VersionHistory
              topicId={topicId}
              versions={versions}
              onLoad={async () => setVersions((await listTopicDocumentVersions(topicId)).versions)}
              currentVersion={doc.version}
              onOpenCitation={openCitation}
            />
          </>
        )}

        {error && (
          <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
        )}
      </CardBody>
    </Card>
  );
}

/** Collapsible list of past versions; expanding one renders it in full. */
function VersionHistory({
  topicId,
  versions,
  onLoad,
  currentVersion,
  onOpenCitation,
}: {
  topicId: string;
  versions: TopicDocumentVersionDto[] | null;
  onLoad: () => Promise<void>;
  currentVersion: number | null;
  onOpenCitation: (citation: TopicDocumentCitation) => void;
}) {
  const [loaded, setLoaded] = useState(false);

  const ensure = async () => {
    if (loaded) return;
    try {
      await onLoad();
      setLoaded(true);
    } catch {
      // A failed history load is non-fatal — the current document still shows.
    }
  };

  // Only worth showing once there is more than the current version.
  const older = (versions ?? []).filter((v) => v.version !== currentVersion);

  return (
    <Accordion isCompact className="px-0">
      <AccordionItem
        key="history"
        aria-label="Version history"
        title={<span className="text-sm text-default-500">Version history</span>}
        onPress={() => void ensure()}
      >
        {!loaded ? (
          <div className="py-2">
            <Spinner size="sm" />
          </div>
        ) : older.length === 0 ? (
          <p className="py-1 text-sm text-default-500">No earlier versions yet.</p>
        ) : (
          <Accordion isCompact>
            {older.map((v) => (
              <AccordionItem
                key={v.version}
                aria-label={`Version ${v.version}`}
                title={
                  <span className="text-sm">
                    v{v.version}{' '}
                    <span className="text-default-400">
                      · {formatDate(v.createdAt)} · {v.sourceItemCount} source
                      {v.sourceItemCount === 1 ? '' : 's'}
                    </span>
                  </span>
                }
              >
                <VersionBody
                  topicId={topicId}
                  version={v.version}
                  onOpenCitation={onOpenCitation}
                />
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </AccordionItem>
    </Accordion>
  );
}

function VersionBody({
  topicId,
  version,
  onOpenCitation,
}: {
  topicId: string;
  version: number;
  onOpenCitation: (citation: TopicDocumentCitation) => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [citations, setCitations] = useState<TopicDocumentCitation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTopicDocumentVersion(topicId, version)
      .then((detail) => {
        if (cancelled) return;
        setMarkdown(detail.markdown);
        setCitations(detail.citations);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [topicId, version]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (markdown === null) return <Spinner size="sm" />;
  return (
    <div className="flex flex-col gap-2">
      <Markdown>{markdown}</Markdown>
      {citations.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-default-100 pt-2">
          {citations.map((citation) => (
            <Chip
              key={citation.marker}
              size="sm"
              variant="flat"
              color="primary"
              className="max-w-64 cursor-pointer"
              onClick={() => onOpenCitation(citation)}
            >
              [{citation.marker}] {citation.title ?? 'Untitled'} · {formatDate(citation.occurredAt)}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
