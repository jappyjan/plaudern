import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import type {
  JournalCitation,
  JournalDocumentResponse,
  JournalPeriodListResponse,
  JournalPeriodType,
  JournalVersionDto,
} from '@plaudern/contracts';
import {
  getJournal,
  getJournalVersion,
  listJournalPeriods,
  listJournalVersions,
  regenerateJournal,
} from '../lib/api';
import { Markdown } from '../components/Markdown';
import { BackIcon, BookIcon, LoopIcon, PlayIcon } from '../components/icons';
import { formatDate, formatDateTime, formatDuration } from '../lib/format';

const POLL_INTERVAL_MS = 3000;

const GRANULARITIES: { type: JournalPeriodType; label: string }[] = [
  { type: 'day', label: 'Days' },
  { type: 'week', label: 'Weeks' },
  { type: 'month', label: 'Months' },
  { type: 'year', label: 'Years' },
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A friendly title for a period key (day/week/month/year). */
export function formatPeriodKey(periodType: JournalPeriodType, periodKey: string): string {
  if (periodType === 'day') return formatDate(`${periodKey}T00:00:00.000Z`);
  if (periodType === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    return `${MONTHS[m - 1] ?? periodKey} ${y}`;
  }
  if (periodType === 'year') return periodKey;
  const [y, w] = periodKey.split('-W');
  return `Week ${Number(w)} · ${y}`;
}

/**
 * Auto-journal (JJ-17) index: the days, weeks, months and years the app has
 * composed into narrative diary entries and reviews. Reached from the header —
 * no bottom-nav tab. Selecting a period opens its cited entry.
 */
export function JournalPage() {
  const [periodType, setPeriodType] = useState<JournalPeriodType>('day');
  const [data, setData] = useState<JournalPeriodListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listJournalPeriods(periodType)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [periodType]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4">
      <div className="flex items-center gap-2">
        <BookIcon className="h-5 w-5" />
        <h1 className="text-xl font-bold">Journal</h1>
      </div>
      <p className="text-sm text-default-500">
        Your days, composed automatically from your recordings and calendar — a life journal you
        never had to write. Every line links back to its source.
      </p>

      {/* Granularity selector — plain buttons (iOS-safe, no overlay). */}
      <div className="flex gap-1 rounded-medium bg-default-100 p-1">
        {GRANULARITIES.map((g) => (
          <button
            key={g.type}
            type="button"
            onClick={() => setPeriodType(g.type)}
            className={`flex-1 rounded-small px-3 py-1.5 text-sm font-medium transition-colors ${
              periodType === g.type
                ? 'bg-background text-foreground shadow-sm'
                : 'text-default-500 hover:text-foreground'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-10">
          <Spinner size="sm" label="Loading…" />
        </div>
      )}

      {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}

      {data && !data.enabled && data.periods.length === 0 && (
        <p className="rounded-medium bg-default-50 p-3 text-sm text-default-500">
          Auto-journal is not configured on this server yet.
        </p>
      )}

      {data && data.enabled && data.periods.length === 0 && !loading && (
        <p className="text-sm text-default-500">
          No entries yet. Once you have recordings or calendar events, your journal composes itself
          each evening.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {data?.periods.map((p) => (
          <Card
            key={p.periodKey}
            as={Link}
            to={`/journal/${p.periodType}/${p.periodKey}`}
            isPressable
            className="w-full"
          >
            <CardBody className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{formatPeriodKey(p.periodType, p.periodKey)}</span>
                <span className="text-xs text-default-400">{formatDate(p.generatedAt)}</span>
              </div>
              {p.preview && <p className="line-clamp-2 text-sm text-default-500">{p.preview}</p>}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * One journal entry: its cited narrative body, a manual (re)compose action and
 * its version history. Citations deep-link to the source item (and audio moment
 * when known), the calendar, or — for a rollup — back to the daily entry.
 */
export function JournalEntryPage() {
  const params = useParams<{ periodType: string; periodKey: string }>();
  const periodType = params.periodType as JournalPeriodType;
  const periodKey = params.periodKey ?? '';
  const navigate = useNavigate();

  const [doc, setDoc] = useState<JournalDocumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [versions, setVersions] = useState<JournalVersionDto[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<JournalDocumentResponse | null> => {
    try {
      const fetched = await getJournal(periodType, periodKey);
      setDoc(fetched);
      setError(null);
      return fetched;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [periodType, periodKey]);

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

  const openCitation = (citation: JournalCitation) => {
    if (citation.kind === 'item') {
      const seek =
        citation.startSeconds !== null ? `?t=${Math.max(0, Math.floor(citation.startSeconds))}` : '';
      navigate(`/items/${citation.refId}${seek}`);
    } else if (citation.kind === 'journal') {
      // Rollups cite their children: a year cites months, a week/month cites days.
      const childType = periodType === 'year' ? 'month' : 'day';
      navigate(`/journal/${childType}/${citation.refId}`);
    } else {
      navigate('/calendar');
    }
  };

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setError(null);
    try {
      const fresh = await regenerateJournal(periodType, periodKey);
      setDoc(fresh);
      setVersions(null);
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
  }, [periodType, periodKey, load]);

  const busy = doc?.status === 'queued' || doc?.status === 'processing' || regenerating;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4">
      <div className="flex items-center justify-between gap-2">
        <Button as={Link} to="/journal" variant="light" size="sm" startContent={<BackIcon className="h-4 w-4" />}>
          Journal
        </Button>
        {doc?.enabled && (
          <Button
            size="sm"
            variant="flat"
            startContent={<LoopIcon className="h-4 w-4" />}
            isDisabled={busy}
            isLoading={regenerating}
            onPress={() => void regenerate()}
          >
            {doc?.markdown ? 'Regenerate' : 'Compose'}
          </Button>
        )}
      </div>

      <h1 className="text-xl font-bold">{formatPeriodKey(periodType, periodKey)}</h1>

      {!doc && !error && (
        <div className="flex justify-center py-10">
          <Spinner size="sm" label="Loading…" />
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-sm text-default-500">
          <Spinner size="sm" /> Composing your entry…
        </div>
      )}

      {doc?.status === 'failed' && doc.error && !doc.markdown && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Composition failed: {doc.error}
        </div>
      )}

      {doc && doc.markdown === null && !busy && doc.status !== 'failed' && (
        <p className="text-sm text-default-500">
          {doc.enabled
            ? 'Not composed yet. It writes itself once the day has signals, or you can compose it now.'
            : 'Auto-journal is not configured on this server.'}
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
                      citation.startSeconds !== null ? <PlayIcon className="h-3 w-3" /> : undefined
                    }
                    onClick={() => openCitation(citation)}
                  >
                    [{citation.marker}] {citation.title ?? citationFallback(citation)}
                    {` · ${formatDate(citation.occurredAt)}`}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {doc.generatedAt && (
            <p className="text-xs text-default-400">
              Composed {formatDateTime(doc.generatedAt)}
              {doc.model ? ` · ${doc.model}` : ''}
            </p>
          )}

          <VersionHistory
            periodType={periodType}
            periodKey={periodKey}
            versions={versions}
            open={showHistory}
            onToggle={async () => {
              const next = !showHistory;
              setShowHistory(next);
              if (next && versions === null) {
                try {
                  setVersions((await listJournalVersions(periodType, periodKey)).versions);
                } catch {
                  /* non-fatal — the current entry still shows */
                }
              }
            }}
            currentVersion={doc.version}
            onOpenCitation={openCitation}
          />
        </>
      )}

      {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}
    </div>
  );
}

function citationFallback(c: JournalCitation): string {
  return c.kind === 'event' ? 'Calendar event' : c.kind === 'journal' ? 'That day' : 'Untitled';
}

/** Collapsible list of past versions rendered as a plain toggle (no overlay). */
function VersionHistory({
  periodType,
  periodKey,
  versions,
  open,
  onToggle,
  currentVersion,
  onOpenCitation,
}: {
  periodType: JournalPeriodType;
  periodKey: string;
  versions: JournalVersionDto[] | null;
  open: boolean;
  onToggle: () => void;
  currentVersion: number | null;
  onOpenCitation: (citation: JournalCitation) => void;
}) {
  const older = (versions ?? []).filter((v) => v.version !== currentVersion);
  return (
    <div className="border-t border-default-100 pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-sm text-default-500 hover:text-foreground"
      >
        {open ? '▾' : '▸'} Version history
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {versions === null ? (
            <Spinner size="sm" />
          ) : older.length === 0 ? (
            <p className="text-sm text-default-500">No earlier versions yet.</p>
          ) : (
            older.map((v) => (
              <VersionBody
                key={v.version}
                periodType={periodType}
                periodKey={periodKey}
                version={v}
                onOpenCitation={onOpenCitation}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function VersionBody({
  periodType,
  periodKey,
  version,
  onOpenCitation,
}: {
  periodType: JournalPeriodType;
  periodKey: string;
  version: JournalVersionDto;
  onOpenCitation: (citation: JournalCitation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [citations, setCitations] = useState<JournalCitation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || markdown !== null) return;
    let cancelled = false;
    getJournalVersion(periodType, periodKey, version.version)
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
  }, [expanded, markdown, periodType, periodKey, version.version]);

  return (
    <div className="rounded-medium border border-default-100 p-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-sm text-default-600"
      >
        v{version.version} · {formatDate(version.createdAt)} · {version.sourceItemCount} source
        {version.sourceItemCount === 1 ? '' : 's'}
      </button>
      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          {error && <p className="text-sm text-danger">{error}</p>}
          {markdown === null && !error && <Spinner size="sm" />}
          {markdown !== null && <Markdown>{markdown}</Markdown>}
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
                  [{citation.marker}] {citation.title ?? citationFallback(citation)}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
