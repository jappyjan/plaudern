import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
  Select,
  SelectItem,
  Spinner,
} from '@heroui/react';
import type {
  EntityDetailWithRelationsDto,
  EntityRelationEdgeDto,
  EntityType,
  GraphEntityDto,
  RegistryEntityDto,
  RelationType,
  VoiceProfileDto,
} from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteEntity,
  getEntity,
  getEntityNeighborhood,
  listEntities,
  listSpeakers,
  mergeEntities,
  relinkEntityContact,
  updateEntity,
} from '../lib/api';
import {
  ENTITY_TYPE_COLOR,
  ENTITY_TYPE_LABEL,
  ENTITY_TYPES,
  RELATION_TYPE_LABEL,
} from '../lib/entityLabels';
import { formatDateTime } from '../lib/format';
import { DocumentList, DocumentRow } from '../components/DocumentRow';
import { BackIcon } from '../components/icons';

/**
 * One registry entity: its identity and aliases, the recordings it is mentioned
 * in, and its edges in the knowledge graph grouped by relation type. LLM-stated
 * edges render solid; weak co-occurrence edges are muted. The "Manage" card
 * hosts the merge & correction tooling (JJ-63) as inline panels — no modals,
 * which iOS PWAs can drop (heroui#3222).
 */
export function EntityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [entity, setEntity] = useState<EntityDetailWithRelationsDto | null>(null);
  // The detail endpoint's edges carry only ids; the neighborhood endpoint adds
  // the connected entities' names/types so we can render them as links.
  const [neighbors, setNeighbors] = useState<Map<string, GraphEntityDto>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Bumped after a correction to reload the detail + neighborhood.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Reset so entity→entity navigation (relation links) shows the spinner
    // instead of the previous entity, and a stale error never masks a load.
    setEntity(null);
    setNeighbors(new Map());
    setError(null);
    if (!id) return;

    void (async () => {
      try {
        const detail = await getEntity(id);
        if (!cancelled) setEntity(detail);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    // Fetched independently of the detail: if the neighborhood call fails we
    // degrade to unnamed relation endpoints instead of blanking the page.
    void (async () => {
      try {
        const neighborhood = await getEntityNeighborhood(id);
        if (!cancelled) setNeighbors(new Map(neighborhood.neighbors.map((n) => [n.id, n])));
      } catch {
        // Non-fatal: relations render as "Unknown entity" without it.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      </div>
    );
  }
  if (!entity || !id) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  // Collapse edges into relation-type groups; within a group each edge points at
  // the *other* endpoint (this entity may be source or target).
  const groups = new Map<RelationType, EntityRelationEdgeDto[]>();
  for (const edge of entity.relations) {
    const bucket = groups.get(edge.relationType) ?? [];
    bucket.push(edge);
    groups.set(edge.relationType, bucket);
  }
  const relationGroups = [...groups.entries()];

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-semibold">{entity.canonicalName}</p>
              <p className="text-xs text-default-500">
                {entity.mentionCount} recording{entity.mentionCount === 1 ? '' : 's'} · first seen{' '}
                {formatDateTime(entity.firstSeenAt)}
              </p>
            </div>
            <Chip
              size="sm"
              variant="flat"
              color={ENTITY_TYPE_COLOR[entity.type]}
              className="shrink-0"
            >
              {ENTITY_TYPE_LABEL[entity.type]}
            </Chip>
          </div>

          {entity.voiceProfileId && (
            <Button
              as={Link}
              to={`/contacts/${entity.voiceProfileId}`}
              size="sm"
              variant="flat"
              className="self-start"
            >
              View linked contact
            </Button>
          )}

          {entity.aliases.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold text-default-600">Also known as</p>
              <div className="flex flex-wrap gap-1">
                {entity.aliases.map((alias) => (
                  <Chip key={alias} size="sm" variant="flat">
                    {alias}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <ManageCard entity={entity} onChanged={() => setRefreshKey((k) => k + 1)} />

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-sm font-semibold">Relations</h2>
        </CardHeader>
        <CardBody className="gap-3">
          {relationGroups.length === 0 && (
            <p className="text-sm text-default-500">
              No relations found yet. Edges appear as recordings mentioning this entity alongside
              others are processed.
            </p>
          )}
          {relationGroups.map(([relationType, edges]) => (
            <div key={relationType} className="flex flex-col gap-1">
              <p className="text-xs font-semibold text-default-600">
                {RELATION_TYPE_LABEL[relationType]}
              </p>
              {edges.map((edge) => {
                const otherId =
                  edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
                const other = neighbors.get(otherId);
                return (
                  <RelationRow
                    key={`${edge.sourceEntityId}-${edge.targetEntityId}-${edge.relationType}`}
                    edge={edge}
                    otherId={otherId}
                    other={other}
                  />
                );
              })}
            </div>
          ))}
        </CardBody>
      </Card>

      <DocumentList
        title="Mentions"
        count={entity.mentions.length}
        empty="This entity is not mentioned in any current recording."
      >
        {entity.mentions.map((mention) => (
          <DocumentRow
            key={mention.id}
            variant="row"
            to={`/items/${mention.inboxItemId}`}
            title={`“${mention.surfaceForm}”`}
            subtitle={`${formatDateTime(mention.createdAt)} · open recording`}
          />
        ))}
      </DocumentList>
    </div>
  );
}

type Panel = 'rename' | 'merge' | 'contact' | 'delete';

/**
 * Merge & correction tooling as inline panels (one open at a time). Kept out of
 * modals on purpose: iOS PWAs can drop HeroUI modal opens (heroui#3222).
 */
function ManageCard({
  entity,
  onChanged,
}: {
  entity: EntityDetailWithRelationsDto;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(panel: Panel) {
    setError(null);
    setOpen((cur) => (cur === panel ? null : panel));
  }

  /** Run a mutation with shared busy/error handling; `after` runs on success. */
  async function run(action: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-0">
        <h2 className="text-sm font-semibold">Manage</h2>
      </CardHeader>
      <CardBody className="gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="flat" onPress={() => toggle('rename')}>
            Rename / retype
          </Button>
          <Button size="sm" variant="flat" onPress={() => toggle('merge')}>
            Merge duplicate
          </Button>
          {entity.type === 'person' && (
            <Button size="sm" variant="flat" onPress={() => toggle('contact')}>
              {entity.voiceProfileId ? 'Change contact' : 'Link contact'}
            </Button>
          )}
          <Button size="sm" variant="flat" color="danger" onPress={() => toggle('delete')}>
            Delete
          </Button>
        </div>

        {error && (
          <div className="rounded-medium bg-danger-50 p-2 text-xs text-danger">{error}</div>
        )}

        {open === 'rename' && (
          <RenamePanel
            entity={entity}
            busy={busy}
            onSubmit={(changes) =>
              run(
                () => updateEntity(entity.id, changes),
                () => {
                  setOpen(null);
                  onChanged();
                },
              )
            }
          />
        )}

        {open === 'merge' && (
          <MergePanel
            entity={entity}
            busy={busy}
            onMerge={(victimId) =>
              run(
                () => mergeEntities(entity.id, victimId),
                () => {
                  setOpen(null);
                  onChanged();
                },
              )
            }
          />
        )}

        {open === 'contact' && entity.type === 'person' && (
          <ContactPanel
            entity={entity}
            busy={busy}
            onLink={(voiceProfileId) =>
              run(
                () => relinkEntityContact(entity.id, voiceProfileId),
                () => {
                  setOpen(null);
                  onChanged();
                },
              )
            }
          />
        )}

        {open === 'delete' && (
          <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
            <p className="text-sm">
              Delete <span className="font-semibold">{entity.canonicalName}</span>? Its mentions and
              relations are removed and it will not be recreated by future processing.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                color="danger"
                isLoading={busy}
                onPress={() => run(() => deleteEntity(entity.id), () => navigate('/entities'))}
              >
                Delete permanently
              </Button>
              <Button size="sm" variant="light" onPress={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RenamePanel({
  entity,
  busy,
  onSubmit,
}: {
  entity: EntityDetailWithRelationsDto;
  busy: boolean;
  onSubmit: (changes: { canonicalName?: string; type?: EntityType }) => void;
}) {
  const [name, setName] = useState(entity.canonicalName);
  const [type, setType] = useState<EntityType>(entity.type);
  const trimmed = name.trim();
  const changed = trimmed !== entity.canonicalName || type !== entity.type;

  return (
    <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
      <Input size="sm" label="Name" value={name} onValueChange={setName} />
      <Select
        size="sm"
        label="Type"
        selectedKeys={[type]}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (typeof next === 'string') setType(next as EntityType);
        }}
      >
        {ENTITY_TYPES.map((t) => (
          <SelectItem key={t}>{ENTITY_TYPE_LABEL[t]}</SelectItem>
        ))}
      </Select>
      <Button
        size="sm"
        color="primary"
        className="self-start"
        isLoading={busy}
        isDisabled={!trimmed || !changed}
        onPress={() =>
          onSubmit({
            canonicalName: trimmed !== entity.canonicalName ? trimmed : undefined,
            type: type !== entity.type ? type : undefined,
          })
        }
      >
        Save
      </Button>
    </div>
  );
}

function MergePanel({
  entity,
  busy,
  onMerge,
}: {
  entity: EntityDetailWithRelationsDto;
  busy: boolean;
  onMerge: (victimId: string) => void;
}) {
  const [all, setAll] = useState<RegistryEntityDto[] | null>(null);
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Include unreferenced ghosts so any stray duplicate is mergeable.
      const res = await listEntities(undefined, true).catch(() => null);
      if (!cancelled && res) setAll(res.entities);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only same-type entities can merge (retype first otherwise); never itself.
  const candidates = useMemo(() => {
    if (!all) return [];
    const needle = query.trim().toLowerCase();
    return all
      .filter((e) => e.id !== entity.id && e.type === entity.type)
      .filter(
        (e) =>
          !needle ||
          e.canonicalName.toLowerCase().includes(needle) ||
          e.aliases.some((a) => a.toLowerCase().includes(needle)),
      )
      .slice(0, 25);
  }, [all, query, entity.id, entity.type]);

  const typeLabel = ENTITY_TYPE_LABEL[entity.type].toLowerCase();

  return (
    <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
      <p className="text-xs text-default-500">
        Pick another {typeLabel} to merge INTO{' '}
        <span className="font-semibold">{entity.canonicalName}</span>. Its aliases, mentions and
        relations move here; it is then deleted and will not be recreated.
      </p>
      <Input
        size="sm"
        label="Search entities"
        placeholder="Name or alias…"
        value={query}
        onValueChange={setQuery}
        isClearable
        onClear={() => setQuery('')}
      />
      {all === null ? (
        <Spinner size="sm" />
      ) : candidates.length === 0 ? (
        <p className="text-xs text-default-500">No other {typeLabel} entities match.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {candidates.map((c) =>
            confirmId === c.id ? (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-medium bg-warning-50 p-2"
              >
                <span className="text-sm">Merge “{c.canonicalName}” in?</span>
                <div className="flex gap-1">
                  <Button size="sm" color="primary" isLoading={busy} onPress={() => onMerge(c.id)}>
                    Confirm
                  </Button>
                  <Button size="sm" variant="light" onPress={() => setConfirmId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                key={c.id}
                type="button"
                className="flex items-center justify-between gap-2 rounded-medium p-2 text-left hover:bg-default-200"
                onClick={() => setConfirmId(c.id)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.canonicalName}</p>
                  <p className="text-xs text-default-500">
                    {c.mentionCount} recording{c.mentionCount === 1 ? '' : 's'}
                  </p>
                </div>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ContactPanel({
  entity,
  busy,
  onLink,
}: {
  entity: EntityDetailWithRelationsDto;
  busy: boolean;
  onLink: (voiceProfileId: string | null) => void;
}) {
  const [profiles, setProfiles] = useState<VoiceProfileDto[] | null>(null);
  const [selected, setSelected] = useState<string>(entity.voiceProfileId ?? '');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listSpeakers().catch(() => null);
      if (!cancelled && res) setProfiles(res.profiles);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
      <p className="text-xs text-default-500">
        Link this person to a voice-profile contact, or unlink it.
      </p>
      {profiles === null ? (
        <Spinner size="sm" />
      ) : (
        <Select
          size="sm"
          label="Contact"
          selectedKeys={selected ? [selected] : []}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            setSelected(typeof next === 'string' ? next : '');
          }}
        >
          {profiles.map((p) => (
            <SelectItem key={p.id}>{p.name ?? 'Unnamed contact'}</SelectItem>
          ))}
        </Select>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          color="primary"
          isLoading={busy}
          isDisabled={!selected || selected === entity.voiceProfileId}
          onPress={() => onLink(selected || null)}
        >
          Save
        </Button>
        {entity.voiceProfileId && (
          <Button size="sm" variant="flat" isLoading={busy} onPress={() => onLink(null)}>
            Unlink
          </Button>
        )}
      </div>
    </div>
  );
}

function RelationRow({
  edge,
  otherId,
  other,
}: {
  edge: EntityRelationEdgeDto;
  otherId: string;
  other: GraphEntityDto | undefined;
}) {
  // Weak co-occurrence edges (entities merely mentioned together) are muted so
  // LLM-stated relations stand out.
  const cooccurrence = edge.origin === 'cooccurrence';
  const content = (
    <>
      <div className="min-w-0">
        <span className="truncate text-sm font-medium">
          {other?.canonicalName ?? 'Unknown entity'}
        </span>
        {edge.label && <span className="ml-1 text-xs text-default-500">— {edge.label}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {other && (
          <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[other.type]}>
            {ENTITY_TYPE_LABEL[other.type]}
          </Chip>
        )}
        {cooccurrence ? (
          <Chip size="sm" variant="flat" title="Implied by co-occurrence in a recording">
            co-occurrence
          </Chip>
        ) : (
          edge.confidence !== null && (
            <Chip size="sm" variant="flat" color="success">
              {Math.round(edge.confidence * 100)}%
            </Chip>
          )
        )}
      </div>
    </>
  );

  // Endpoints the neighborhood didn't resolve would 404 as a link — render
  // them as plain muted text instead.
  if (!other) {
    return (
      <div className="flex flex-row items-center justify-between gap-2 rounded-medium p-2 opacity-60">
        {content}
      </div>
    );
  }
  return (
    <Link
      to={`/entities/${otherId}`}
      className={`flex flex-row items-center justify-between gap-2 rounded-medium p-2 hover:bg-default-100 ${
        cooccurrence ? 'opacity-60' : ''
      }`}
    >
      {content}
    </Link>
  );
}

function BackLink() {
  return (
    <Button
      as={Link}
      to="/entities"
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      Entities
    </Button>
  );
}
