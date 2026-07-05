import { useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type {
  DossierCitationDto,
  DossierCommitmentDto,
  DossierFactDto,
  EntityDossierDto,
  GraphEntityDto,
} from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getEntityDossier } from '../lib/api';
import {
  ENTITY_TYPE_COLOR,
  ENTITY_TYPE_LABEL,
  RELATION_TYPE_LABEL,
} from '../lib/entityLabels';
import { formatDate, formatDateTime, formatDuration } from '../lib/format';
import { BackIcon, PeopleIcon, PlayIcon } from '../components/icons';

/**
 * The person dossier (JJ-24): before you meet someone, this page IS your memory
 * of them. One aggregated view of everything the platform knows about a single
 * registry entity — active personal facts with a collapsible superseded-history
 * timeline, commitments in both directions, open questions, knowledge-graph
 * relations and the recent recordings that mention them — every element
 * deep-linking to its source recording (and audio moment) exactly like chat
 * citations (JJ-37).
 *
 * iOS-first PWA: no HeroUI modals/accordions (which can drop on iOS,
 * heroui#3222) — the superseded-facts history is a plain toggled div.
 */
export function DossierPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dossier, setDossier] = useState<EntityDossierDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDossier(null);
    setError(null);
    setShowSuperseded(false);
    if (!id) return;
    void (async () => {
      try {
        const res = await getEntityDossier(id);
        if (!cancelled) setDossier(res);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const openCitation = (citation: DossierCitationDto | null) => {
    if (!citation) return;
    const seek =
      citation.startSeconds !== null ? `?t=${Math.max(0, Math.floor(citation.startSeconds))}` : '';
    navigate(`/items/${citation.inboxItemId}${seek}`);
  };

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink id={id} />
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      </div>
    );
  }
  if (!dossier || !id) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading dossier…" />
      </div>
    );
  }

  const { entity, facts, commitments, openQuestions, relations, neighbors, recentItems, counts } =
    dossier;
  const neighborById = new Map<string, GraphEntityDto>(neighbors.map((n) => [n.id, n]));

  return (
    <div className="flex flex-col gap-4 pb-24">
      <BackLink id={id} />

      {/* Identity */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-semibold">{entity.canonicalName}</p>
              <p className="text-xs text-default-500">
                {counts.mentions} recording{counts.mentions === 1 ? '' : 's'} · last seen{' '}
                {formatDate(entity.lastSeenAt)}
              </p>
            </div>
            <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[entity.type]}>
              {ENTITY_TYPE_LABEL[entity.type]}
            </Chip>
          </div>

          <div className="flex flex-wrap gap-2">
            {entity.voiceProfileId && (
              <Button
                as={Link}
                to={`/contacts/${entity.voiceProfileId}`}
                size="sm"
                variant="flat"
                startContent={<PeopleIcon className="h-4 w-4" />}
              >
                {entity.voiceProfileName ?? 'Linked contact'}
              </Button>
            )}
            <Button as={Link} to={`/entities/${entity.id}`} size="sm" variant="flat">
              Entity & relations
            </Button>
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

      {/* Facts */}
      <SectionCard title="Facts" count={counts.activeFacts}>
        {facts.active.length === 0 ? (
          <Empty>No facts recorded about this person yet.</Empty>
        ) : (
          facts.active.map((fact) => (
            <FactRow key={fact.id} fact={fact} onOpen={openCitation} />
          ))
        )}

        {facts.superseded.length > 0 && (
          <div className="mt-1 flex flex-col gap-2">
            <button
              type="button"
              className="self-start text-xs font-medium text-primary hover:underline"
              onClick={() => setShowSuperseded((v) => !v)}
              aria-expanded={showSuperseded}
            >
              {showSuperseded ? 'Hide' : 'Show'} history ({counts.supersededFacts} superseded)
            </button>
            {/* Plain positioned div, not an accordion — iOS PWA safe. */}
            {showSuperseded && (
              <div className="flex flex-col gap-2 border-l-2 border-default-200 pl-3">
                {facts.superseded.map((fact) => (
                  <FactRow key={fact.id} fact={fact} onOpen={openCitation} superseded />
                ))}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* Commitments */}
      {(counts.owedByMe > 0 || counts.owedToMe > 0) && (
        <SectionCard title="Commitments" count={counts.owedByMe + counts.owedToMe}>
          {commitments.owedByMe.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-default-600">
                I owe {entity.canonicalName}
              </p>
              {commitments.owedByMe.map((c) => (
                <CommitmentRow key={c.id} commitment={c} onOpen={openCitation} />
              ))}
            </div>
          )}
          {commitments.owedToMe.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-default-600">
                {entity.canonicalName} owes me
              </p>
              {commitments.owedToMe.map((c) => (
                <CommitmentRow key={c.id} commitment={c} onOpen={openCitation} />
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Open questions */}
      {openQuestions.length > 0 && (
        <SectionCard title="Open questions" count={counts.openQuestions}>
          {openQuestions.map((q) => (
            <div key={q.id} className="flex flex-col gap-1 rounded-medium bg-default-50 p-2">
              <p className="text-sm">{q.question}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-default-500">
                  {q.direction === 'asked_by_me' ? 'I asked' : 'They asked'}
                </span>
                {q.citation && <CitationChip citation={q.citation} onOpen={openCitation} />}
              </div>
            </div>
          ))}
        </SectionCard>
      )}

      {/* Relations */}
      {relations.length > 0 && (
        <SectionCard title="Relations" count={counts.relations}>
          {relations.map((edge) => {
            const otherId =
              edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
            const other = neighborById.get(otherId);
            const content = (
              <>
                <div className="min-w-0">
                  <span className="truncate text-sm font-medium">
                    {other?.canonicalName ?? 'Unknown entity'}
                  </span>
                  <span className="ml-1 text-xs text-default-500">
                    {RELATION_TYPE_LABEL[edge.relationType]}
                    {edge.label ? ` · ${edge.label}` : ''}
                  </span>
                </div>
                {other && (
                  <Chip size="sm" variant="flat" color={ENTITY_TYPE_COLOR[other.type]}>
                    {ENTITY_TYPE_LABEL[other.type]}
                  </Chip>
                )}
              </>
            );
            const muted = edge.origin === 'cooccurrence';
            return other ? (
              <Link
                key={`${edge.sourceEntityId}-${edge.targetEntityId}-${edge.relationType}`}
                to={`/entities/${otherId}/dossier`}
                className={`flex items-center justify-between gap-2 rounded-medium p-2 hover:bg-default-100 ${
                  muted ? 'opacity-60' : ''
                }`}
              >
                {content}
              </Link>
            ) : (
              <div
                key={`${edge.sourceEntityId}-${edge.targetEntityId}-${edge.relationType}`}
                className="flex items-center justify-between gap-2 rounded-medium p-2 opacity-60"
              >
                {content}
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* Recent mentions */}
      <SectionCard title="Recent recordings" count={counts.mentions}>
        {recentItems.length === 0 ? (
          <Empty>Not mentioned in any current recording.</Empty>
        ) : (
          recentItems.map((item) => (
            <Link
              key={item.inboxItemId}
              to={`/items/${item.inboxItemId}`}
              className="flex flex-col gap-0.5 rounded-medium p-2 hover:bg-default-100"
            >
              <span className="truncate text-sm font-medium">
                {item.title ?? `“${item.surfaceForm}”`}
              </span>
              <span className="text-xs text-default-500">{formatDateTime(item.occurredAt)}</span>
            </Link>
          ))
        )}
        {counts.mentions > recentItems.length && (
          <Link
            to={`/entities/${entity.id}`}
            className="self-start text-xs font-medium text-primary hover:underline"
          >
            View all {counts.mentions} mentions
          </Link>
        )}
      </SectionCard>
    </div>
  );
}

function FactRow({
  fact,
  onOpen,
  superseded,
}: {
  fact: DossierFactDto;
  onOpen: (citation: DossierCitationDto | null) => void;
  superseded?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${superseded ? 'opacity-70' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="text-default-500">{fact.attribute}: </span>
          <span className={superseded ? 'line-through' : 'font-medium'}>{fact.value}</span>
        </p>
        {superseded && fact.supersededAt && (
          <span className="shrink-0 text-xs text-default-400">
            until {formatDate(fact.supersededAt)}
          </span>
        )}
      </div>
      {fact.citations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {fact.citations.map((citation, i) => (
            <CitationChip key={`${citation.inboxItemId}-${i}`} citation={citation} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitmentRow({
  commitment,
  onOpen,
}: {
  commitment: DossierCommitmentDto;
  onOpen: (citation: DossierCitationDto | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-medium bg-default-50 p-2">
      <p className="text-sm">{commitment.description}</p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {commitment.dueDate && (
            <Chip size="sm" variant="flat" color="warning">
              due {formatDate(commitment.dueDate)}
            </Chip>
          )}
          {commitment.status !== 'open' && (
            <Chip size="sm" variant="flat">
              {commitment.status}
            </Chip>
          )}
        </div>
        {commitment.citation && (
          <CitationChip citation={commitment.citation} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

/** A tappable source-item citation, mirroring the chat citation chip (JJ-37). */
function CitationChip({
  citation,
  onOpen,
}: {
  citation: DossierCitationDto;
  onOpen: (citation: DossierCitationDto) => void;
}) {
  return (
    <Chip
      size="sm"
      variant="flat"
      color="primary"
      className="max-w-64 cursor-pointer"
      startContent={citation.startSeconds !== null ? <PlayIcon className="h-3 w-3" /> : undefined}
      onClick={() => onOpen(citation)}
    >
      {citation.title ?? 'Untitled'}
      {citation.startSeconds !== null && ` · ${formatDuration(citation.startSeconds)}`}
      {` · ${formatDate(citation.occurredAt)}`}
    </Chip>
  );
}

function SectionCard({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count > 0 && (
          <Chip size="sm" variant="flat">
            {count}
          </Chip>
        )}
      </CardHeader>
      <CardBody className="gap-3">{children}</CardBody>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-default-500">{children}</p>;
}

function BackLink({ id }: { id: string | undefined }) {
  return (
    <Button
      as={Link}
      to={id ? `/entities/${id}` : '/entities'}
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      Back
    </Button>
  );
}
