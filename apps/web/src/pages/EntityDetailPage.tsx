import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type {
  EntityDetailWithRelationsDto,
  EntityRelationEdgeDto,
  GraphEntityDto,
  RelationType,
} from '@plaudern/contracts';
import { Link, useParams } from 'react-router-dom';
import { getEntity, getEntityNeighborhood } from '../lib/api';
import {
  ENTITY_TYPE_COLOR,
  ENTITY_TYPE_LABEL,
  RELATION_TYPE_LABEL,
} from '../lib/entityLabels';
import { formatDateTime } from '../lib/format';
import { BackIcon } from '../components/icons';

/**
 * One registry entity: its identity and aliases, the recordings it is mentioned
 * in, and its edges in the knowledge graph grouped by relation type. LLM-stated
 * edges render solid; weak co-occurrence edges are muted.
 */
export function EntityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [entity, setEntity] = useState<EntityDetailWithRelationsDto | null>(null);
  // The detail endpoint's edges carry only ids; the neighborhood endpoint adds
  // the connected entities' names/types so we can render them as links.
  const [neighbors, setNeighbors] = useState<Map<string, GraphEntityDto>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, neighborhood] = await Promise.all([
        getEntity(id),
        getEntityNeighborhood(id),
      ]);
      setEntity(detail);
      setNeighbors(new Map(neighborhood.neighbors.map((n) => [n.id, n])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-sm font-semibold">Mentions</h2>
        </CardHeader>
        <CardBody className="gap-2">
          {entity.mentions.length === 0 && (
            <p className="text-sm text-default-500">
              This entity is not mentioned in any current recording.
            </p>
          )}
          {entity.mentions.map((mention) => (
            <Link
              key={mention.id}
              to={`/items/${mention.inboxItemId}`}
              className="flex flex-col gap-0.5 rounded-medium p-2 text-sm hover:bg-default-100"
            >
              <span className="truncate font-medium">“{mention.surfaceForm}”</span>
              <span className="text-xs text-default-500">
                {formatDateTime(mention.createdAt)} · open recording
              </span>
            </Link>
          ))}
        </CardBody>
      </Card>
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
  return (
    <Link
      to={`/entities/${otherId}`}
      className={`flex flex-row items-center justify-between gap-2 rounded-medium p-2 hover:bg-default-100 ${
        cooccurrence ? 'opacity-60' : ''
      }`}
    >
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
