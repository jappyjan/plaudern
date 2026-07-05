import { useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Input, Spinner } from '@heroui/react';
import type {
  DuplicateCandidateDto,
  EntityContactSuggestionDto,
  EntityDetailWithRelationsDto,
  EntityRelationEdgeDto,
  EntityType,
  GraphEntityDto,
  ReconcileRecommendation,
  RegistryEntityDto,
  RelationType,
} from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  convertEntityToContact,
  deleteEntity,
  duplicateCandidates,
  getEntity,
  getEntityContactSuggestions,
  getEntityNeighborhood,
  linkEntityContact,
  listEntities,
  mergeEntities,
  reconcileEntity,
  unlinkEntityContact,
} from '../lib/api';
import {
  ENTITY_TYPE_COLOR,
  ENTITY_TYPE_LABEL,
  RELATION_TYPE_LABEL,
} from '../lib/entityLabels';
import { formatDateTime } from '../lib/format';
import { DocumentList, DocumentRow } from '../components/DocumentRow';
import { EntityEditModal } from '../components/EntityEditModal';
import { EntityLinkContactModal } from '../components/EntityLinkContactModal';
import { BackIcon, EditIcon, LinkIcon, PeopleIcon, UnlinkIcon } from '../components/icons';

/**
 * One registry entity: its identity and aliases, the recordings it is mentioned
 * in, and its edges in the knowledge graph grouped by relation type. The list
 * shows only relations the model actually asserted; weak same-recording
 * co-occurrence edges are excluded server-side so it carries signal, not every
 * pair mentioned together. Person entities also carry their contact-book link,
 * manageable here (link/unlink/convert, JJ-63).
 * The Manage card hosts merge-duplicate and delete as inline panels — not
 * modals, which iOS PWAs can drop (heroui#3222).
 */
export function EntityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [entity, setEntity] = useState<EntityDetailWithRelationsDto | null>(null);
  // The detail endpoint's edges carry only ids; the neighborhood endpoint adds
  // the connected entities' names/types so we can render them as links.
  const [neighbors, setNeighbors] = useState<Map<string, GraphEntityDto>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<EntityContactSuggestionDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset so entity→entity navigation (relation links) shows the spinner
    // instead of the previous entity, and a stale error never masks a load.
    setEntity(null);
    setNeighbors(new Map());
    setError(null);
    setActionError(null);
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
  }, [id]);

  // The resolver's best candidate, offered inline for unlinked people. Purely
  // an enrichment: failures leave the page fully functional.
  const isUnlinkedPerson = entity?.type === 'person' && !entity.voiceProfileId;
  useEffect(() => {
    let cancelled = false;
    setSuggestion(null);
    if (!id || !isUnlinkedPerson) return;
    void (async () => {
      try {
        const res = await getEntityContactSuggestions(id);
        if (!cancelled) setSuggestion(res.suggestions[0] ?? null);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isUnlinkedPerson]);

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

  // Mutations return the fresh detail DTO, so the page updates in place.
  const runAction = async (action: () => Promise<EntityDetailWithRelationsDto>) => {
    setBusy(true);
    setActionError(null);
    try {
      setEntity(await action());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink type={entity.type} />

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
            <div className="flex shrink-0 items-center gap-1">
              <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[entity.type]}>
                {ENTITY_TYPE_LABEL[entity.type]}
              </Chip>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label="Edit entity"
                isDisabled={busy}
                onPress={() => setEditOpen(true)}
              >
                <EditIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {entity.type === 'person' && (
              <Button
                as={Link}
                to={`/entities/${entity.id}/dossier`}
                size="sm"
                variant="solid"
                color="primary"
              >
                View dossier
              </Button>
            )}
            <Button
              as={Link}
              to={`/entities/graph?seed=${entity.id}`}
              size="sm"
              variant="flat"
              color="primary"
            >
              View in graph
            </Button>
          </div>

          {entity.type === 'person' &&
            (entity.voiceProfileId ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  as={Link}
                  to={`/contacts/${entity.voiceProfileId}`}
                  size="sm"
                  variant="flat"
                  startContent={<PeopleIcon className="h-4 w-4" />}
                >
                  {entity.voiceProfileName ?? 'View linked contact'}
                </Button>
                {entity.voiceProfileLinkOrigin === 'auto' && (
                  <Chip size="sm" variant="flat" title="Linked automatically by name/recording match">
                    auto-linked
                  </Chip>
                )}
                <Button
                  size="sm"
                  variant="light"
                  color="danger"
                  isDisabled={busy}
                  startContent={<UnlinkIcon className="h-4 w-4" />}
                  onPress={() => void runAction(() => unlinkEntityContact(entity.id))}
                >
                  Unlink
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {suggestion && (
                  <div className="flex flex-col gap-1 rounded-medium bg-default-50 p-3">
                    <p className="text-sm">
                      Is this{' '}
                      <span className="font-medium">
                        {suggestion.name ?? 'an unnamed contact'}
                      </span>
                      ?{' '}
                      <span className="text-default-500">
                        {Math.round(suggestion.confidence * 100)}% match
                      </span>
                    </p>
                    {suggestion.reasons.length > 0 && (
                      <p className="text-xs text-default-500">{suggestion.reasons.join(' · ')}</p>
                    )}
                    <Button
                      size="sm"
                      color="primary"
                      variant="flat"
                      className="self-start"
                      isDisabled={busy}
                      startContent={<LinkIcon className="h-4 w-4" />}
                      onPress={() =>
                        void runAction(() => linkEntityContact(entity.id, suggestion.voiceProfileId))
                      }
                    >
                      Link to {suggestion.name ?? 'this contact'}
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={busy}
                    startContent={<LinkIcon className="h-4 w-4" />}
                    onPress={() => setLinkOpen(true)}
                  >
                    Link to contact
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={busy}
                    startContent={<PeopleIcon className="h-4 w-4" />}
                    onPress={() => void runAction(() => convertEntityToContact(entity.id))}
                  >
                    Add to contacts
                  </Button>
                  {entity.voiceProfileLinkOrigin === 'suppressed' && (
                    <Chip size="sm" variant="flat" title="You unlinked this entity; it won't re-link automatically">
                      auto-link off
                    </Chip>
                  )}
                </div>
              </div>
            ))}

          {actionError && <p className="text-sm text-danger">{actionError}</p>}

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

      <ManageCard entity={entity} onMerged={setEntity} />

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-sm font-semibold">Relations</h2>
        </CardHeader>
        <CardBody className="gap-3">
          {relationGroups.length === 0 && (
            <p className="text-sm text-default-500">
              No relations found yet. Edges appear as recordings state a connection between this
              entity and another.
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

      <EntityEditModal
        isOpen={editOpen}
        entity={entity}
        onClose={() => setEditOpen(false)}
        onSaved={setEntity}
      />
      <EntityLinkContactModal
        isOpen={linkOpen}
        entity={entity}
        onClose={() => setLinkOpen(false)}
        onLinked={setEntity}
      />
    </div>
  );
}

type Panel = 'merge' | 'duplicates' | 'delete';

/**
 * Merge & delete tooling (JJ-63) as inline panels (one open at a time), kept
 * out of modals on purpose: iOS PWAs can drop HeroUI modal opens
 * (heroui#3222). Rename/retype lives in EntityEditModal, contact linking in
 * the identity card — this card owns the destructive registry corrections.
 */
function ManageCard({
  entity,
  onMerged,
}: {
  entity: EntityDetailWithRelationsDto;
  onMerged: (fresh: EntityDetailWithRelationsDto) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(panel: Panel) {
    setError(null);
    setOpen((cur) => (cur === panel ? null : panel));
  }

  // Merge `victimId` INTO this entity (the survivor is the one being viewed, so
  // it keeps its type). Shared by the manual picker and the duplicate finder.
  function runMerge(victimId: string) {
    setBusy(true);
    setError(null);
    void mergeEntities(entity.id, victimId)
      .then((fresh) => {
        setOpen(null);
        onMerged(fresh);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader className="pb-0">
        <h2 className="text-sm font-semibold">Manage</h2>
      </CardHeader>
      <CardBody className="gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="flat" onPress={() => toggle('duplicates')}>
            Find duplicates
          </Button>
          <Button size="sm" variant="flat" onPress={() => toggle('merge')}>
            Merge duplicate
          </Button>
          <Button size="sm" variant="flat" color="danger" onPress={() => toggle('delete')}>
            Delete
          </Button>
        </div>

        {error && (
          <div className="rounded-medium bg-danger-50 p-2 text-xs text-danger">{error}</div>
        )}

        {open === 'duplicates' && (
          <DuplicatesPanel entity={entity} busy={busy} onMerge={runMerge} />
        )}

        {open === 'merge' && <MergePanel entity={entity} busy={busy} onMerge={runMerge} />}

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
                onPress={() => {
                  setBusy(true);
                  setError(null);
                  void deleteEntity(entity.id)
                    .then(() => navigate('/entities'))
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                      setBusy(false);
                    });
                }}
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

  // Any entity (including a different type) can merge INTO this one; the
  // survivor keeps this entity's type. Never itself.
  const candidates = useMemo(() => {
    if (!all) return [];
    const needle = query.trim().toLowerCase();
    return all
      .filter((e) => e.id !== entity.id)
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
        Pick another entity to merge INTO{' '}
        <span className="font-semibold">{entity.canonicalName}</span>. It keeps this {typeLabel}
        &rsquo;s type; the other&rsquo;s aliases, mentions and relations move here, then it is
        deleted and will not be recreated.
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
        <p className="text-xs text-default-500">No other entities match.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {candidates.map((c) =>
            confirmId === c.id ? (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-medium bg-warning-50 p-2"
              >
                <span className="text-sm">
                  Merge &ldquo;{c.canonicalName}&rdquo;
                  {c.type !== entity.type ? ` (${ENTITY_TYPE_LABEL[c.type].toLowerCase()})` : ''} in?
                </span>
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
                <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[c.type]}>
                  {ENTITY_TYPE_LABEL[c.type]}
                </Chip>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function reasonLabel(reason: DuplicateCandidateDto['reason']): string {
  return reason === 'exact-cross-type' ? 'Same name, different type' : 'Similar name';
}

/**
 * Finds likely duplicates of this entity — an entity with the same name under a
 * different type (the extractor's split-typed case), plus, when "Include similar
 * names" is on, fuzzy matches worth confirming. Merging keeps THIS entity (the
 * survivor); the picked candidate is folded in and deleted.
 */
function DuplicatesPanel({
  entity,
  busy,
  onMerge,
}: {
  entity: EntityDetailWithRelationsDto;
  busy: boolean;
  onMerge: (victimId: string) => void;
}) {
  const [fuzzy, setFuzzy] = useState(false);
  const [web, setWeb] = useState(false);
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    setError(null);
    void duplicateCandidates(entity.id, fuzzy)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [entity.id, fuzzy]);

  return (
    <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
      <p className="text-xs text-default-500">
        Possible duplicates of <span className="font-semibold">{entity.canonicalName}</span>. Merging
        keeps this entity and its type; the other is folded in and deleted.
      </p>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs text-default-600">
          <input type="checkbox" checked={fuzzy} onChange={(e) => setFuzzy(e.target.checked)} />
          Include similar names
        </label>
        <label className="flex items-center gap-2 text-xs text-default-600">
          <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
          Research on the web (Ask AI)
        </label>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {candidates === null ? (
        <Spinner size="sm" />
      ) : candidates.length === 0 ? (
        <p className="text-xs text-default-500">No likely duplicates found.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {candidates.map(({ candidate: c, reason }) => (
            <DuplicateRow
              key={c.id}
              entity={entity}
              candidate={c}
              reason={reason}
              busy={busy}
              web={web}
              onMerge={onMerge}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One candidate row: shows the match, an optional AI verdict, and a merge confirm. */
function DuplicateRow({
  entity,
  candidate: c,
  reason,
  busy,
  web,
  onMerge,
}: {
  entity: EntityDetailWithRelationsDto;
  candidate: RegistryEntityDto;
  reason: DuplicateCandidateDto['reason'];
  busy: boolean;
  web: boolean;
  onMerge: (victimId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  // undefined = not asked; null = judge unavailable.
  const [rec, setRec] = useState<ReconcileRecommendation | null | undefined>(undefined);
  const [askError, setAskError] = useState<string | null>(null);

  function ask() {
    setAsking(true);
    setAskError(null);
    void reconcileEntity(entity.id, c.id, web)
      .then((res) => setRec(res.recommendation))
      .catch((cause: unknown) => setAskError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setAsking(false));
  }

  return (
    <div className="flex flex-col gap-1 rounded-medium bg-content1 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{c.canonicalName}</p>
          <p className="text-xs text-default-500">{reasonLabel(reason)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[c.type]}>
            {ENTITY_TYPE_LABEL[c.type]}
          </Chip>
          <Button size="sm" variant="light" isLoading={asking} onPress={ask}>
            Ask AI
          </Button>
          {confirming ? (
            <>
              <Button size="sm" color="primary" isLoading={busy} onPress={() => onMerge(c.id)}>
                Confirm
              </Button>
              <Button size="sm" variant="light" onPress={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="flat" onPress={() => setConfirming(true)}>
              Merge
            </Button>
          )}
        </div>
      </div>
      {confirming && c.type !== entity.type && (
        <p className="text-xs text-warning-600">
          Cross-type merge: kept as {ENTITY_TYPE_LABEL[entity.type].toLowerCase()}.
        </p>
      )}
      {askError && <p className="text-xs text-danger">{askError}</p>}
      {rec === null && (
        <p className="text-xs text-default-500">AI judging is not configured.</p>
      )}
      {rec && (
        <div className="rounded-medium bg-default-100 p-2 text-xs">
          <p>
            <span className="font-semibold">
              {rec.sameThing ? 'Likely the same' : 'Likely different'}
            </span>{' '}
            ({Math.round(rec.confidence * 100)}% confident
            {rec.usedWeb ? ', web-assisted' : ''}) — recommends{' '}
            {ENTITY_TYPE_LABEL[rec.recommendedType].toLowerCase()}, keep{' '}
            {rec.survivorId === entity.id ? 'this entity' : `“${c.canonicalName}”`}.
          </p>
          {rec.rationale && <p className="mt-1 text-default-500">{rec.rationale}</p>}
        </div>
      )}
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

/**
 * People are reached from the People hub, everything else from Entities — so a
 * person entity's back link returns to the right list.
 */
function BackLink({ type }: { type?: EntityType }) {
  const toPeople = type === 'person';
  return (
    <Button
      as={Link}
      to={toPeople ? '/contacts' : '/entities'}
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      {toPeople ? 'People' : 'Entities'}
    </Button>
  );
}
