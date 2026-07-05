import { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody, Chip, Input, Select, SelectItem, Spinner } from '@heroui/react';
import type { EntityType, MergeSuggestionDto, RegistryEntityDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { dismissMergeSuggestion, listEntities, listMergeSuggestions } from '../lib/api';
import {
  ENTITY_TYPE_COLOR,
  ENTITY_TYPE_LABEL,
  ENTITY_TYPE_LABEL_PLURAL,
  ENTITY_TYPES,
} from '../lib/entityLabels';

/**
 * Entity registry browser: the named things the LLM has pulled out of your
 * recordings — organizations, places, products, dates, amounts and more — the
 * seed of the knowledge graph. People live in the People hub (`/contacts`),
 * where their heard voice and their mentions are unified, so `person` entities
 * are deliberately excluded here. Searchable and filterable by type.
 */

/** Every entity type except `person` — people are shown in the People hub. */
const THING_TYPES: EntityType[] = ENTITY_TYPES.filter((t) => t !== 'person');

export function EntitiesPage() {
  const [entities, setEntities] = useState<RegistryEntityDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<EntityType | 'all'>('all');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Unreferenced ghosts stay hidden (the API default) — the list should
        // reflect what the recordings actually say today. People are surfaced
        // in the People hub, so drop `person` rows here.
        const res = await listEntities();
        if (!cancelled) setEntities(res.entities.filter((e) => e.type !== 'person'));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!entities) return [];
    const needle = query.trim().toLowerCase();
    return entities.filter((e) => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (!needle) return true;
      return (
        e.canonicalName.toLowerCase().includes(needle) ||
        e.aliases.some((a) => a.toLowerCase().includes(needle))
      );
    });
  }, [entities, query, typeFilter]);

  // Group the filtered entities by type, preserving the canonical type order.
  const groups = useMemo(() => {
    const byType = new Map<EntityType, RegistryEntityDto[]>();
    for (const entity of filtered) {
      const bucket = byType.get(entity.type) ?? [];
      bucket.push(entity);
      byType.set(entity.type, bucket);
    }
    return THING_TYPES.filter((t) => byType.has(t)).map((type) => ({
      type,
      items: byType.get(type)!.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    }));
  }, [filtered]);

  if (error) {
    return <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>;
  }
  if (!entities) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Entities</h2>
        <Button as={Link} to="/entities/graph" size="sm" variant="flat" color="primary">
          View graph
        </Button>
      </div>

      <DuplicateSuggestions />

      {entities.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              size="sm"
              label="Search"
              placeholder="Name or alias…"
              value={query}
              onValueChange={setQuery}
              isClearable
              onClear={() => setQuery('')}
              className="max-w-64"
            />
            <Select
              size="sm"
              label="Type"
              className="max-w-48"
              selectedKeys={[typeFilter]}
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (typeof next === 'string') setTypeFilter(next as EntityType | 'all');
              }}
            >
              <>
                <SelectItem key="all">All types</SelectItem>
                {THING_TYPES.map((type) => (
                  <SelectItem key={type}>{ENTITY_TYPE_LABEL_PLURAL[type]}</SelectItem>
                ))}
              </>
            </Select>
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-default-500">No entities match your search.</p>
          ) : (
            groups.map((group) => (
              <div key={group.type} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-default-600">
                    {ENTITY_TYPE_LABEL_PLURAL[group.type]}
                  </h3>
                  <Chip size="sm" variant="flat">
                    {group.items.length}
                  </Chip>
                </div>
                {group.items.map((entity) => (
                  <EntityRow key={entity.id} entity={entity} />
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

/**
 * Pending duplicate suggestions detected automatically after extraction — pairs
 * of entities with the same name under different types. Renders nothing when
 * there are none. Each row links to an entity's page (where "Find duplicates"
 * drives the confirmed merge) and offers a Dismiss.
 */
function DuplicateSuggestions() {
  const [suggestions, setSuggestions] = useState<MergeSuggestionDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listMergeSuggestions()
      .then((res) => {
        if (!cancelled) setSuggestions(res.suggestions);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss(id: string) {
    setSuggestions((cur) => (cur ? cur.filter((s) => s.id !== id) : cur));
    void dismissMergeSuggestion(id).catch(() => {
      // Best-effort; a failed dismiss reappears on the next load.
    });
  }

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <Card className="bg-warning-50">
      <CardBody className="flex flex-col gap-2">
        <p className="text-sm font-semibold">
          Possible duplicates{' '}
          <Chip size="sm" variant="flat" color="warning">
            {suggestions.length}
          </Chip>
        </p>
        <p className="text-xs text-default-500">
          These were extracted with the same name under different types. Open one to review and
          merge.
        </p>
        {suggestions.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-2 rounded-medium bg-content1 p-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span className="truncate text-sm font-medium">{s.entity.canonicalName}</span>
              <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[s.entity.type]}>
                {ENTITY_TYPE_LABEL[s.entity.type]}
              </Chip>
              <span className="text-xs text-default-500">↔</span>
              <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[s.candidate.type]}>
                {ENTITY_TYPE_LABEL[s.candidate.type]}
              </Chip>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button as={Link} to={`/entities/${s.entity.id}`} size="sm" variant="flat">
                Review
              </Button>
              <Button size="sm" variant="light" onPress={() => dismiss(s.id)}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function EntityRow({ entity }: { entity: RegistryEntityDto }) {
  return (
    <Card as={Link} to={`/entities/${entity.id}`} isPressable>
      <CardBody className="flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entity.canonicalName}</p>
          <p className="text-xs text-default-500">
            {entity.mentionCount} recording{entity.mentionCount === 1 ? '' : 's'}
          </p>
        </div>
        <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[entity.type]} className="shrink-0">
          {ENTITY_TYPE_LABEL[entity.type]}
        </Chip>
      </CardBody>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardBody className="flex flex-col gap-2 py-8 text-center">
        <p className="text-sm font-medium">No entities yet</p>
        <p className="mx-auto max-w-md text-sm text-default-500">
          As your recordings are processed, the organizations, places, products, dates and other
          things mentioned in them are extracted and collected here — the seed of your knowledge
          graph. (People get their own hub under People.) Existing recordings are folded in as
          backfill runs, so this fills up over time.
        </p>
      </CardBody>
    </Card>
  );
}
