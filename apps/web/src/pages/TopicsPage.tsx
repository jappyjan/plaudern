import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardBody, Chip, Spinner } from '@heroui/react';
import type { TopicDto, TopicProposalDto, TopicProposalGeneration } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import {
  acceptTopicProposal,
  dismissTopicProposal,
  generateTopicProposals,
  listTopicProposals,
  listTopics,
} from '../lib/api';
import { TopicModal } from '../components/TopicModal';
import { TagIcon } from '../components/icons';

/**
 * The editable topic/project taxonomy. New and reprocessed inbox items are
 * classified against these entries automatically; archiving keeps history but
 * hides a topic from future classification.
 */
export function TopicsPage() {
  const [topics, setTopics] = useState<TopicDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listTopics();
      setTopics(res.topics);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>;
  }
  if (!topics) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const active = topics.filter((t) => !t.archived);
  const archived = topics.filter((t) => t.archived);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Topics</h2>
        <Button size="sm" color="primary" onPress={() => setModalOpen(true)}>
          New topic
        </Button>
      </div>

      <TopicProposals onAccepted={() => void load()} />

      {topics.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
              <TagIcon className="h-6 w-6" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No topics yet</p>
              <p className="max-w-sm text-sm text-default-500">
                Create your first topic or project. New and reprocessed items get classified
                against your topics automatically.
              </p>
            </div>
            <Button size="sm" color="primary" onPress={() => setModalOpen(true)}>
              Create your first topic
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-default-500">
            New and reprocessed items are classified against these topics automatically.
          </p>
          {active.map((topic) => (
            <TopicCard key={topic.id} topic={topic} />
          ))}
          {active.length === 0 && (
            <p className="text-sm text-default-500">
              All topics are archived. Create a new one or unarchive an existing topic.
            </p>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Archived</h2>
            <Chip size="sm" variant="flat">
              {archived.length}
            </Chip>
          </div>
          <p className="text-sm text-default-500">
            Hidden from future classification; past assignments are kept.
          </p>
          {archived.map((topic) => (
            <TopicCard key={topic.id} topic={topic} archived />
          ))}
        </div>
      )}

      <TopicModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => void load()}
      />
    </div>
  );
}

/**
 * Suggested taxonomy extensions from embedding clusters (JJ-64), rendered as a
 * section of the topics page — no separate route. Hidden entirely when the
 * feature is disabled (embeddings or the labeling LLM unconfigured) or there is
 * nothing to suggest, so it never nags. Accepting one creates the topic and
 * reclassifies the cluster's items server-side; dismissing suppresses it.
 */
const PROPOSAL_POLL_INTERVAL_MS = 3000;

/**
 * A generation run is in flight while its status is queued or processing.
 * `generation` is absent when talking to an older API that has no run tracking
 * (a deploy-window skew) — treated as "no run in flight".
 */
function isGenerating(generation: TopicProposalGeneration | undefined): boolean {
  return generation?.status === 'queued' || generation?.status === 'processing';
}

function TopicProposals({ onAccepted }: { onAccepted: () => void }) {
  const [proposals, setProposals] = useState<TopicProposalDto[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<TopicProposalGeneration | null> => {
    try {
      const res = await listTopicProposals();
      setProposals(res.proposals);
      setEnabled(res.enabled);
      setGenerating(isGenerating(res.generation));
      if (res.generation?.status === 'failed' && res.generation.error) {
        setError(res.generation.error);
      }
      return res.generation ?? null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  // Poll the list while a generation run is in flight, so the async worker's
  // results appear without a manual refresh. Self-cancelling once it settles.
  const startPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const tick = async () => {
      const generation = await load();
      if (generation && isGenerating(generation)) {
        pollRef.current = setTimeout(() => void tick(), PROPOSAL_POLL_INTERVAL_MS);
      }
    };
    pollRef.current = setTimeout(() => void tick(), PROPOSAL_POLL_INTERVAL_MS);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load().then((generation) => {
      if (!cancelled && generation && isGenerating(generation)) startPolling();
    });
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [load, startPolling]);

  const generate = useCallback(async () => {
    setError(null);
    try {
      // Enqueue-and-return (202): the worker runs the slow pass; poll for it.
      const res = await generateTopicProposals();
      setProposals(res.proposals);
      setEnabled(res.enabled);
      setGenerating(isGenerating(res.generation));
      if (isGenerating(res.generation)) startPolling();
      else if (res.generation?.status === 'failed' && res.generation.error) {
        setError(res.generation.error);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [startPolling]);

  const accept = useCallback(
    async (id: string) => {
      setBusy(id);
      setError(null);
      try {
        await acceptTopicProposal(id);
        setProposals((prev) => prev.filter((p) => p.id !== id));
        onAccepted();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [onAccepted],
  );

  const dismiss = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await dismissTopicProposal(id);
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  // Stay out of the way until we know the feature is usable.
  if (!loaded || !enabled) return null;

  const hasProposals = proposals.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Suggested topics</h2>
          {proposals.length > 0 && (
            <Chip size="sm" variant="flat">
              {proposals.length}
            </Chip>
          )}
        </div>
        <Button
          size="sm"
          variant="flat"
          isLoading={generating}
          isDisabled={generating}
          onPress={() => void generate()}
        >
          {hasProposals ? 'Refresh' : 'Suggest topics'}
        </Button>
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {generating && (
        <p className="text-sm text-default-500">
          Looking for clusters of recent items… this runs in the background and can take a minute.
        </p>
      )}

      {!generating && hasProposals && (
        <p className="text-sm text-default-500">
          We found clusters of recent items that don&apos;t fit your topics yet. Accepting one
          creates the topic and reclassifies its items.
        </p>
      )}

      {proposals.map((proposal) => (
        <Card key={proposal.id}>
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{proposal.label}</p>
              <p className="text-xs text-default-500">
                {proposal.itemCount} recent item{proposal.itemCount === 1 ? '' : 's'}
                {proposal.description ? ` — ${proposal.description}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="light"
                isDisabled={busy === proposal.id}
                onPress={() => void dismiss(proposal.id)}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                color="primary"
                isLoading={busy === proposal.id}
                onPress={() => void accept(proposal.id)}
              >
                Create topic
              </Button>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function TopicCard({ topic, archived }: { topic: TopicDto; archived?: boolean }) {
  return (
    <Card as={Link} to={`/topics/${topic.id}`} isPressable className={archived ? 'opacity-70' : ''}>
      <CardBody className="flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{topic.name}</p>
          {topic.description && (
            <p className="truncate text-xs text-default-500">{topic.description}</p>
          )}
        </div>
        {archived && (
          <Chip size="sm" variant="flat" className="shrink-0">
            archived
          </Chip>
        )}
      </CardBody>
    </Card>
  );
}
