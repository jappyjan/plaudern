import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CardBody, Chip, Input, Select, SelectItem, Spinner } from '@heroui/react';
import type {
  RegistryEntityDto,
  SearchFilters,
  SearchRequest,
  SearchResponse,
  SourceType,
  TopicDto,
} from '@plaudern/contracts';
import { listEntities, listTopics, searchMemory } from '../lib/api';
import { ChatIcon, SearchIcon } from '../components/icons';

const SOURCE_TYPES: { key: SourceType; label: string }[] = [
  { key: 'audio', label: 'Audio' },
  { key: 'text', label: 'Text note' },
  { key: 'file', label: 'File' },
  { key: 'plaud', label: 'Plaud' },
  { key: 'web', label: 'Web clip' },
  { key: 'email', label: 'Email' },
];

const SOURCE_LABEL: Record<string, string> = Object.fromEntries(
  SOURCE_TYPES.map((s) => [s.key, s.label]),
);

/** Renders a snippet's `<mark>…</mark>` markers as highlighted text (XSS-safe:
 *  the surrounding text is rendered by React as escaped text nodes). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>.*?<\/mark>)/g);
  return (
    <p className="text-sm text-default-600">
      {parts.map((part, i) => {
        const match = /^<mark>(.*)<\/mark>$/s.exec(part);
        if (match) {
          return (
            <mark key={i} className="rounded bg-warning-100 px-0.5 text-foreground">
              {match[1]}
            </mark>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </p>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Convert a native `<input type="date">` value (YYYY-MM-DD) to an ISO instant. */
function dayStartIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
function dayEndIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [sourceType, setSourceType] = useState<SourceType | 'all'>('all');
  const [topicId, setTopicId] = useState('all');
  const [entityId, setEntityId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [topics, setTopics] = useState<TopicDto[]>([]);
  const [entities, setEntities] = useState<RegistryEntityDto[]>([]);

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load filter options once.
  useEffect(() => {
    let cancelled = false;
    void listTopics()
      .then((res) => !cancelled && setTopics(res.topics.filter((t) => !t.archived)))
      .catch(() => undefined);
    void listEntities()
      .then((res) => !cancelled && setEntities(res.entities))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const filters = useMemo<SearchFilters>(() => {
    const f: SearchFilters = {};
    if (sourceType !== 'all') f.sourceType = sourceType;
    if (topicId !== 'all') f.topicId = topicId;
    if (entityId !== 'all') f.entityId = entityId;
    const fromIso = dayStartIso(from);
    const toIso = dayEndIso(to);
    if (fromIso) f.from = fromIso;
    if (toIso) f.to = toIso;
    return f;
  }, [sourceType, topicId, entityId, from, to]);

  const trimmedQuery = query.trim();
  const hasFilters = Object.keys(filters).length > 0;
  const canSearch = trimmedQuery.length > 0 || hasFilters;

  // Debounced search on any query/filter change.
  useEffect(() => {
    if (!canSearch) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      const req: SearchRequest = { limit: 30 };
      if (trimmedQuery) req.query = trimmedQuery;
      if (hasFilters) req.filters = filters;
      searchMemory(req)
        .then((res) => {
          if (cancelled) return;
          setResponse(res);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : 'Search failed');
          setResponse(null);
        })
        .finally(() => !cancelled && setLoading(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [trimmedQuery, hasFilters, filters, canSearch]);

  const results = response?.results ?? [];

  return (
    <div className="flex flex-col gap-4 pb-28">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Search your memory</h1>
        <Button
          as={Link}
          to="/chat"
          size="sm"
          variant="flat"
          color="primary"
          startContent={<ChatIcon className="h-4 w-4" />}
        >
          Ask your memory
        </Button>
      </div>

      <Input
        size="lg"
        autoFocus
        placeholder="Search across everything…"
        value={query}
        onValueChange={setQuery}
        isClearable
        onClear={() => setQuery('')}
        startContent={<SearchIcon className="h-5 w-5 text-default-400" />}
        aria-label="Search query"
      />

      <div className="flex flex-wrap items-end gap-2">
        <Select
          size="sm"
          label="Source"
          className="max-w-40"
          selectedKeys={[sourceType]}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (typeof next === 'string') setSourceType(next as SourceType | 'all');
          }}
        >
          <>
            <SelectItem key="all">Any source</SelectItem>
            {SOURCE_TYPES.map((s) => (
              <SelectItem key={s.key}>{s.label}</SelectItem>
            ))}
          </>
        </Select>

        <Select
          size="sm"
          label="Topic"
          className="max-w-48"
          selectedKeys={[topicId]}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (typeof next === 'string') setTopicId(next);
          }}
        >
          <>
            <SelectItem key="all">Any topic</SelectItem>
            {topics.map((t) => (
              <SelectItem key={t.id}>{t.name}</SelectItem>
            ))}
          </>
        </Select>

        <Select
          size="sm"
          label="Person / entity"
          className="max-w-48"
          selectedKeys={[entityId]}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (typeof next === 'string') setEntityId(next);
          }}
        >
          <>
            <SelectItem key="all">Anyone</SelectItem>
            {entities.map((e) => (
              <SelectItem key={e.id}>{e.canonicalName}</SelectItem>
            ))}
          </>
        </Select>

        <Input
          size="sm"
          type="date"
          label="From"
          className="max-w-40"
          value={from}
          onValueChange={setFrom}
        />
        <Input
          size="sm"
          type="date"
          label="To"
          className="max-w-40"
          value={to}
          onValueChange={setTo}
        />
      </div>

      {response && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-default-500">
          <LegChip label="Keyword" status={response.legs.keyword} />
          <LegChip label="Semantic" status={response.legs.semantic} />
          {response.legs.notes.map((note, i) => (
            <span key={i} className="italic">
              {note}
            </span>
          ))}
        </div>
      )}

      {!canSearch && (
        <p className="text-sm text-default-500">
          Type a query, or pick a filter, to search across your whole memory.
        </p>
      )}

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {loading && (
        <div className="flex justify-center py-12">
          <Spinner label="Searching…" />
        </div>
      )}

      {!loading && canSearch && !error && results.length === 0 && (
        <p className="text-sm text-default-500">No matches. Try a different query or fewer filters.</p>
      )}

      <div className="flex flex-col gap-2">
        {results.map((r) => (
          <Card key={r.itemId} as={Link} to={`/items/${r.itemId}`} isPressable>
            <CardBody className="gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{r.title ?? 'Untitled'}</span>
                <span className="shrink-0 text-xs text-default-400">{formatDate(r.occurredAt)}</span>
              </div>
              {r.snippet && <Snippet text={r.snippet} />}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Chip size="sm" variant="flat">
                  {SOURCE_LABEL[r.sourceType] ?? r.sourceType}
                </Chip>
                {r.semanticScore !== null && (
                  <Chip size="sm" variant="flat" color="secondary">
                    semantic
                  </Chip>
                )}
                {r.keywordScore !== null && (
                  <Chip size="sm" variant="flat" color="primary">
                    keyword
                  </Chip>
                )}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

function LegChip({ label, status }: { label: string; status: SearchResponse['legs']['keyword'] }) {
  const color = status === 'ran' ? 'success' : status === 'unavailable' ? 'warning' : 'default';
  return (
    <Chip size="sm" variant="flat" color={color}>
      {label}: {status}
    </Chip>
  );
}
