import { useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type {
  EntityContactSuggestionDto,
  EntityDetailWithRelationsDto,
  EntityRelationEdgeDto,
  GraphEntityDto,
  RelationType,
} from '@plaudern/contracts';
import { Link, useParams } from 'react-router-dom';
import {
  convertEntityToContact,
  getEntity,
  getEntityContactSuggestions,
  getEntityNeighborhood,
  linkEntityContact,
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
 * in, and its edges in the knowledge graph grouped by relation type. LLM-stated
 * edges render solid; weak co-occurrence edges are muted. Person entities also
 * carry their contact-book link, manageable here (link/unlink/convert, JJ-63).
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
